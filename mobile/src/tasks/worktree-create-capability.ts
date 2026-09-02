import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcSuccess } from '../transport/types'
import { readMobileRuntimeHostPlatform } from '../transport/mobile-runtime-host-platform'
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
  hostPlatform: NodeJS.Platform | null
}

const UNSUPPORTED_CAPABILITIES: NewWorktreeRuntimeCapabilities = {
  tasksSupported: false,
  worktreeCreateIdempotency: false,
  hostPlatform: null
}

// Why: status.get is safe to replay and must settle before create, independently
// of slower provider probes, so ambiguous cutover retries are gated correctly.
export async function readNewWorktreeRuntimeCapabilities(
  client: RpcClient
): Promise<NewWorktreeRuntimeCapabilities> {
  for (let migrationRetry = 0; ; migrationRetry += 1) {
    try {
      const response = await client.sendRequest('status.get')
      if (!response.ok) {
        return UNSUPPORTED_CAPABILITIES
      }
      const result = (response as RpcSuccess).result as {
        capabilities?: string[]
        worktreeCreateIdempotency?: unknown
      }
      const capabilities = result.capabilities ?? []
      const supportsIdempotency = capabilities.includes(
        MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY
      )
      const advertisedIdempotency = result.worktreeCreateIdempotency
      return {
        tasksSupported: capabilities.includes(MOBILE_TASKS_CAPABILITY),
        worktreeCreateIdempotency: supportsIdempotency
          ? advertisedIdempotency === undefined
            ? { dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS }
            : advertisedIdempotency !== null &&
                typeof advertisedIdempotency === 'object' &&
                !Array.isArray(advertisedIdempotency)
              ? resolveWorktreeCreateIdempotencySupport(
                  (advertisedIdempotency as { dedupeTtlMs?: unknown }).dedupeTtlMs
                )
              : { dedupeTtlMs: 0 }
          : false,
        hostPlatform: readMobileRuntimeHostPlatform(result)
      }
    } catch (error) {
      if (!isLogicalClientCutoverError(error) || migrationRetry >= STATUS_CUTOVER_MAX_RETRIES) {
        return UNSUPPORTED_CAPABILITIES
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
} {
  const [tasksSupported, setTasksSupported] = useState(false)
  const [hostPlatform, setHostPlatform] = useState<NodeJS.Platform | null>(null)
  const capabilityProbeRef = useRef<{
    client: RpcClient | null
    promise: Promise<NewWorktreeRuntimeCapabilities>
  } | null>(null)
  const getCapabilities = useCallback((): Promise<NewWorktreeRuntimeCapabilities> => {
    if (!capabilityProbeRef.current || capabilityProbeRef.current.client !== client) {
      // Why: a queued tap can reach Create before passive effects run; lazily
      // starting one shared probe keeps that path from failing open.
      capabilityProbeRef.current = {
        client,
        promise: client
          ? readNewWorktreeRuntimeCapabilities(client)
          : Promise.resolve(UNSUPPORTED_CAPABILITIES)
      }
    }
    return capabilityProbeRef.current.promise
  }, [client])

  useEffect(() => {
    if (!enabled || !client) {
      return
    }
    let stale = false
    void getCapabilities().then((capabilities) => {
      if (!stale) {
        setTasksSupported(capabilities.tasksSupported)
        setHostPlatform(capabilities.hostPlatform)
      }
    })
    return () => {
      stale = true
    }
  }, [client, enabled, getCapabilities, setTasksSupported])

  const getWorktreeCreateCutoverSupport = useCallback(
    () => getCapabilities().then((capabilities) => capabilities.worktreeCreateIdempotency),
    [getCapabilities]
  )
  return { tasksSupported, hostPlatform, getWorktreeCreateCutoverSupport }
}
