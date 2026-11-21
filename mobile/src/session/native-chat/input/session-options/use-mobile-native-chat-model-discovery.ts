import { useEffect, useState } from 'react'
import * as z from 'zod'
import { getAgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type { CatalogModel } from '../../../../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import {
  catalogModelsFromModelDiscovery,
  mergeDiscoveredCatalogModels
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-discovered-catalog-models'
import { defineRpcOperation, runRpcOperation } from '../../../../transport/rpc/rpc-operation'
import type { UnvalidatedRpcRequestPort } from '../../../../transport/rpc/unvalidated-rpc-request-port'

const discoveredModel = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string().optional(),
  thinkingLevels: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  supportsFastMode: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  contextWindowTokens: z.number().optional(),
  resolvedModel: z.string().optional()
})

const discoveryResult = z.union([
  z.object({
    success: z.literal(true),
    catalogOrigin: z.enum(['probe', 'spec']).optional(),
    models: z.array(discoveredModel)
  }),
  z.object({ success: z.literal(false) })
])

const discoverModels = defineRpcOperation({
  name: 'native-chat.configured-models',
  method: 'git.discoverCommitMessageModels',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: (raw: unknown) => {
    const parsed = discoveryResult.safeParse(raw)
    return {
      compatible: true as const,
      variant: 'configured-models' as const,
      value: parsed.success ? parsed.data : null,
      salvage: { droppedPaths: [], droppedCount: 0 }
    }
  }
})

type DiscoveryClient = UnvalidatedRpcRequestPort

// In-flight only. The host keeps the 10 minute list and drops it on agent refresh; a client TTL
// would keep serving the previous host after that clear, and must not be shared across RPC clients.
const flightsByClient = new WeakMap<DiscoveryClient, Map<string, Promise<CatalogModel[] | null>>>()
const clientPassIds = new WeakMap<DiscoveryClient, number>()
let nextClientPassId = 1

function clientPassId(client: DiscoveryClient): string {
  const existing = clientPassIds.get(client)
  if (existing !== undefined) {
    return String(existing)
  }
  const created = nextClientPassId
  nextClientPassId += 1
  clientPassIds.set(client, created)
  return String(created)
}

function flightsFor(client: DiscoveryClient): Map<string, Promise<CatalogModel[] | null>> {
  const existing = flightsByClient.get(client)
  if (existing) {
    return existing
  }
  const created = new Map<string, Promise<CatalogModel[] | null>>()
  flightsByClient.set(client, created)
  return created
}

function startFlight(
  flights: Map<string, Promise<CatalogModel[] | null>>,
  scope: string,
  load: () => Promise<CatalogModel[] | null>
): Promise<CatalogModel[] | null> {
  let flight = Promise.resolve<CatalogModel[] | null>(null)
  flight = load().finally(() => {
    if (flights.get(scope) === flight) {
      flights.delete(scope)
    }
  })
  flights.set(scope, flight)
  return flight
}

export type MobileNativeChatModelDiscovery = {
  models: CatalogModel[] | null
  /** The current visit's probe failed. Hidden and in-flight visits stay false. */
  failed: boolean
}

/** The runtime resolves the workspace's execution host, including SSH and folder workspaces. */
export function useMobileNativeChatModelDiscovery(args: {
  client: Parameters<typeof runRpcOperation>[0] | null
  agent: string | null
  hostId: string
  worktreeId: string
  enabled: boolean
}): MobileNativeChatModelDiscovery {
  const { client, agent, hostId, worktreeId, enabled } = args
  const scope = JSON.stringify([hostId, worktreeId, agent])
  const activePass =
    enabled && client && worktreeId && agent ? `${clientPassId(client)}:${scope}` : ''
  const [seenPass, setSeenPass] = useState(activePass)
  const [visit, setVisit] = useState(0)
  const passChanged = seenPass !== activePass
  if (passChanged) {
    setSeenPass(activePass)
    setVisit(visit + 1)
  }
  const passKey = `${passChanged ? visit + 1 : visit}:${activePass}`
  const [attempt, setAttempt] = useState<{
    passKey: string
    models: CatalogModel[] | null
    failed: boolean
  } | null>(null)
  useEffect(() => {
    const catalog = agent ? getAgentSessionOptionCatalog(agent) : null
    if (!enabled || !client || !worktreeId || !agent || !catalog) {
      return
    }
    let cancelled = false
    const flights = flightsFor(client)
    const flight =
      flights.get(scope) ??
      startFlight(flights, scope, () =>
        runRpcOperation(client, discoverModels, {
          worktree: `id:${worktreeId}`,
          agentId: agent
        })
          .then((discovery) => {
            const models = discovery ? catalogModelsFromModelDiscovery(agent, discovery) : null
            return models === null ? null : mergeDiscoveredCatalogModels(agent, catalog, models)
          })
          .catch(() => null)
      )
    void flight.then((models) => {
      if (cancelled) {
        return
      }
      if (models) {
        setAttempt({ passKey, models, failed: false })
        return
      }
      // A failed refresh must not keep the previous catalog selectable.
      setAttempt({ passKey, models: null, failed: true })
    })
    return () => {
      cancelled = true
    }
  }, [agent, client, enabled, passKey, scope, worktreeId])
  const current = enabled && attempt?.passKey === passKey ? attempt : null
  return {
    models: current && !current.failed ? current.models : null,
    failed: current?.failed === true
  }
}
