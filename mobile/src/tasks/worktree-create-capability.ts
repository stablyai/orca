import { useCallback, useEffect, useRef, useState } from 'react'
import { readAgentLaunchSupport, type AgentLaunchSupport } from './agent-launch-request'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { readMobileRuntimeHostPlatform } from '../transport/mobile-runtime-host-platform'
import { worktreeCreateCapabilityRead } from './mobile-workspace-create-operations'
import { MOBILE_TASKS_CAPABILITY } from './mobile-tasks-capability'
import {
  WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS,
  resolveWorktreeCreateIdempotencySupport,
  type WorktreeCreateIdempotencySupport
} from './worktree-create-idempotency-policy'

// Why: older hosts strip worktree.create's clientMutationId, so mobile must not
// replay an ambiguous create unless the host advertises idempotency support.
// Mirrors WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY in the shared protocol.
export const MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY = 'worktree.create-idempotency.v1'

const STATUS_CUTOVER_MAX_RETRIES = 5

export type NewWorktreeRuntimeCapabilities = {
  tasksSupported: boolean
  worktreeCreateIdempotency: WorktreeCreateIdempotencySupport | false
  /** Whether the host can route a create through `agent.launch`, and what that launch supports;
   *  an older one only knows `worktree.create` + `startupAgent`, always a terminal agent. */
  agentLaunch: AgentLaunchSupport | false
  hostPlatform: NodeJS.Platform | null
}

// Why: status.get is safe to replay and must settle before create, independently
// of slower provider probes, so ambiguous cutover retries are gated correctly.
export async function readNewWorktreeRuntimeCapabilities(
  client: RpcClient
): Promise<NewWorktreeRuntimeCapabilities | null> {
  for (let migrationRetry = 0; ; migrationRetry += 1) {
    try {
      const status = worktreeCreateCapabilityRead.interpret(
        await worktreeCreateCapabilityRead.request(client)
      )
      if (!status.accepted) {
        return null
      }
      const result = status.value
      const capabilities = result.capabilities ?? []
      const supportsIdempotency = capabilities.includes(
        MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY
      )
      const advertisedIdempotency = result.worktreeCreateIdempotency
      return {
        tasksSupported: capabilities.includes(MOBILE_TASKS_CAPABILITY),
        agentLaunch: readAgentLaunchSupport(capabilities),
        worktreeCreateIdempotency: supportsIdempotency
          ? advertisedIdempotency === undefined
            ? { dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS }
            : advertisedIdempotency !== null &&
                typeof advertisedIdempotency === 'object' &&
                !Array.isArray(advertisedIdempotency)
              ? resolveWorktreeCreateIdempotencySupport(
                  'dedupeTtlMs' in advertisedIdempotency
                    ? advertisedIdempotency.dedupeTtlMs
                    : undefined
                )
              : { dedupeTtlMs: 0 }
          : false,
        hostPlatform: readMobileRuntimeHostPlatform(result)
      }
    } catch (error) {
      if (!isLogicalClientCutoverError(error) || migrationRetry >= STATUS_CUTOVER_MAX_RETRIES) {
        return null
      }
    }
  }
}

export function useNewWorktreeRuntimeCapabilities(
  client: RpcClient | null,
  enabled: boolean
): {
  tasksSupported: boolean
  hostPlatform: NodeJS.Platform | null
  getWorktreeCreateCutoverSupport: () => Promise<WorktreeCreateIdempotencySupport | false>
  getAgentLaunchSupport: () => Promise<AgentLaunchSupport | false>
} {
  const [capabilityState, setCapabilityState] = useState<{
    client: RpcClient
    generation: number | undefined
    connectedAt: number | null | undefined
    capabilities: NewWorktreeRuntimeCapabilities
  } | null>(null)
  const capabilityProbeRef = useRef<{
    client: RpcClient | null
    generation: number | undefined
    connectedAt: number | null | undefined
    promise: Promise<NewWorktreeRuntimeCapabilities | null>
  } | null>(null)
  const getCapabilities = useCallback(async (): Promise<NewWorktreeRuntimeCapabilities | null> => {
    const generation = client?.getGeneration?.()
    const connectedAt = client?.getLastConnectedAt()
    let probe = capabilityProbeRef.current
    if (
      !probe ||
      probe.client !== client ||
      probe.generation !== generation ||
      probe.connectedAt !== connectedAt
    ) {
      // A queued create can arrive before passive effects; share its status barrier.
      probe = {
        client,
        generation,
        connectedAt,
        promise: client ? readNewWorktreeRuntimeCapabilities(client) : Promise.resolve(null)
      }
      capabilityProbeRef.current = probe
    }
    const capabilities = await probe.promise
    if (
      capabilityProbeRef.current !== probe ||
      client?.getGeneration?.() !== generation ||
      client?.getLastConnectedAt() !== connectedAt
    ) {
      return null
    }
    if (!capabilities && capabilityProbeRef.current === probe) {
      // A failed request says nothing about what the host supports.
      capabilityProbeRef.current = null
    }
    return capabilities
  }, [client])

  useEffect(() => {
    if (capabilityProbeRef.current?.client !== client) {
      capabilityProbeRef.current = null
    }
  }, [client])

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Cleanup cancels the timer and fences async rearming.
  useEffect(() => {
    if (!enabled || !client) {
      return
    }
    let stale = false
    let refreshVersion = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 1_000
    const refresh = async () => {
      if (stale) {
        return
      }
      const version = ++refreshVersion
      clearTimeout(retry)
      const capabilities = await getCapabilities()
      if (stale || version !== refreshVersion) {
        return
      }
      if (capabilities) {
        setCapabilityState({
          client,
          generation: client.getGeneration?.(),
          connectedAt: client.getLastConnectedAt(),
          capabilities
        })
        retryDelay = 1_000
      }
      if (!capabilityProbeRef.current && client.getState() === 'connected') {
        retry = setTimeout(() => void refresh(), retryDelay)
        retryDelay = Math.min(retryDelay * 2, 30_000)
      }
    }
    const unsubscribe = client.onStateChange((state) => {
      if (state === 'connected') {
        setCapabilityState(null)
        capabilityProbeRef.current = null
        void refresh()
      }
    })
    void refresh()
    return () => {
      stale = true
      clearTimeout(retry)
      unsubscribe()
    }
  }, [client, enabled, getCapabilities])

  const getWorktreeCreateCutoverSupport = useCallback(
    () =>
      getCapabilities().then((capabilities) => capabilities?.worktreeCreateIdempotency ?? false),
    [getCapabilities]
  )
  const getAgentLaunchSupport = useCallback(
    () => getCapabilities().then((capabilities) => capabilities?.agentLaunch ?? false),
    [getCapabilities]
  )
  const capabilities =
    capabilityState?.client === client &&
    capabilityState?.generation === client?.getGeneration?.() &&
    capabilityState?.connectedAt === client?.getLastConnectedAt()
      ? capabilityState?.capabilities
      : null
  return {
    tasksSupported: capabilities?.tasksSupported ?? false,
    hostPlatform: capabilities?.hostPlatform ?? null,
    getWorktreeCreateCutoverSupport,
    getAgentLaunchSupport
  }
}
