import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcSuccess } from '../transport/types'
import { MOBILE_TASKS_CAPABILITY } from './mobile-tasks-capability'

// Why: older hosts strip worktree.create's clientMutationId, so mobile must not
// replay an ambiguous create unless the host advertises idempotency support.
// Mirrors WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY in the shared protocol.
export const MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY = 'worktree.create-idempotency.v1'

const STATUS_CUTOVER_MAX_RETRIES = 5

export type NewWorktreeRuntimeCapabilities = {
  tasksSupported: boolean
  idempotentWorktreeCreateSupported: boolean
}

const UNSUPPORTED_CAPABILITIES: NewWorktreeRuntimeCapabilities = {
  tasksSupported: false,
  idempotentWorktreeCreateSupported: false
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
      const capabilities =
        ((response as RpcSuccess).result as { capabilities?: string[] }).capabilities ?? []
      return {
        tasksSupported: capabilities.includes(MOBILE_TASKS_CAPABILITY),
        idempotentWorktreeCreateSupported: capabilities.includes(
          MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY
        )
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
  getWorktreeCreateCutoverSupport: () => Promise<boolean>
} {
  const [tasksSupported, setTasksSupported] = useState(false)
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
      }
    })
    return () => {
      stale = true
    }
  }, [client, enabled, getCapabilities, setTasksSupported])

  const getWorktreeCreateCutoverSupport = useCallback(
    () => getCapabilities().then((capabilities) => capabilities.idempotentWorktreeCreateSupported),
    [getCapabilities]
  )
  return { tasksSupported, getWorktreeCreateCutoverSupport }
}
