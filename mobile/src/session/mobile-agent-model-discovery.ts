import { useEffect, useState } from 'react'
import type { AgentType } from '../../../src/shared/agent-status-types'
import type { CatalogModel } from '../../../src/shared/agent-session-option-catalog'
import {
  toDiscoveredCatalogModels,
  type DiscoveredAgentModelsResult
} from '../../../src/shared/discovered-agent-model-catalog'
import type { RpcClient } from '../transport/rpc-client'

// Why: the probe shells out to the agent CLI on the host, which is slow to cold
// start. Desktop allows the same budget for this call.
const MODEL_DISCOVERY_TIMEOUT_MS = 75_000

// Keyed by host + worktree, not host alone: worktrees on one host can execute on
// different SSH targets whose CLIs differ, so one probe result must not speak for
// another execution host. Bounded so a long session across many worktrees cannot
// grow this unbounded.
const MODEL_DISCOVERY_CACHE_CAP = 32
const modelsByScope = new Map<string, Promise<CatalogModel[] | null>>()
const hostsWithoutDiscovery = new Set<string>()

function discoveryScopeKey(hostId: string, worktreeId: string, agent: AgentType): string {
  return `${hostId}\0${worktreeId}\0${agent}`
}

function rememberScope(key: string, models: Promise<CatalogModel[] | null>): void {
  modelsByScope.set(key, models)
  while (modelsByScope.size > MODEL_DISCOVERY_CACHE_CAP) {
    const oldest = modelsByScope.keys().next().value
    if (oldest === undefined) {
      break
    }
    modelsByScope.delete(oldest)
  }
}

type ProbeOutcome = {
  models: CatalogModel[] | null
  /** A transport failure answered nothing about the host — retry on a later mount. */
  retryable: boolean
}

async function probeCatalogModels(args: {
  client: RpcClient
  hostId: string
  worktreeId: string
  agent: AgentType
}): Promise<ProbeOutcome> {
  let response
  try {
    response = await args.client.sendRequest(
      'git.discoverCommitMessageModels',
      { worktree: `id:${args.worktreeId}`, agentId: args.agent },
      { timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS }
    )
  } catch {
    // Timeout or disconnect. The seed list stays in place and a reconnect re-probes.
    return { models: null, retryable: true }
  }
  if (!response.ok) {
    if (response.error.code === 'method_not_found') {
      // Why: RPC availability is host-wide; a host predating this method must not
      // be re-probed for every worktree the user opens.
      hostsWithoutDiscovery.add(args.hostId)
    }
    return { models: null, retryable: false }
  }
  return {
    models: toDiscoveredCatalogModels(args.agent, response.result as DiscoveredAgentModelsResult),
    retryable: false
  }
}

/**
 * The host's live model list for this agent, or null to keep the seed catalog.
 * Probes once per host+worktree+agent; concurrent callers share one request.
 */
export function discoverMobileAgentCatalogModels(args: {
  client: RpcClient
  hostId: string
  worktreeId: string
  agent: AgentType
}): Promise<CatalogModel[] | null> {
  if (hostsWithoutDiscovery.has(args.hostId)) {
    return Promise.resolve(null)
  }
  const key = discoveryScopeKey(args.hostId, args.worktreeId, args.agent)
  const cached = modelsByScope.get(key)
  if (cached) {
    return cached
  }
  const outcome = probeCatalogModels(args).catch(
    (): ProbeOutcome => ({ models: null, retryable: true })
  )
  const pending = outcome.then(({ models }) => models)
  rememberScope(key, pending)
  void outcome.then(({ retryable }) => {
    // Why: a transport failure must not pin "no models" for the rest of the
    // session — drop the entry so a later mount retries against a live connection.
    if (retryable && modelsByScope.get(key) === pending) {
      modelsByScope.delete(key)
    }
  })
  return pending
}

export function clearMobileAgentModelDiscoveryForTests(): void {
  modelsByScope.clear()
  hostsWithoutDiscovery.clear()
}

/**
 * The host's live model list for this agent+worktree, or null while it is
 * unknown. Why: the seed catalog carries version-neutral family aliases only, so
 * without this the picker cannot offer host-specific variants such as `opus[1m]`.
 * A failed or unsupported probe simply leaves the seed in place.
 */
export function useDiscoveredAgentCatalogModels(args: {
  agent: string | null
  client: RpcClient | null
  hostId: string
  worktreeId: string
  enabled: boolean
}): CatalogModel[] | null {
  const { agent, client, hostId, worktreeId, enabled } = args
  const [models, setModels] = useState<CatalogModel[] | null>(null)
  useEffect(() => {
    setModels(null)
    if (!enabled || !client || !agent) {
      return
    }
    let cancelled = false
    void discoverMobileAgentCatalogModels({
      client,
      hostId,
      worktreeId,
      agent: agent as AgentType
    }).then((discovered) => {
      if (!cancelled && discovered && discovered.length > 0) {
        setModels(discovered)
      }
    })
    return () => {
      cancelled = true
    }
  }, [agent, client, enabled, hostId, worktreeId])
  return models
}
