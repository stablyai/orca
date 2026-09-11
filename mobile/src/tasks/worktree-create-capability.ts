import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { readRpcClientGeneration } from '../transport/rpc-client-generation'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcSuccess } from '../transport/types'
import { readMobileRuntimeHostPlatform } from '../transport/mobile-runtime-host-platform'
import { startSettlingStatusProbe } from '../transport/runtime-capability-probe'
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
const AUTHORITATIVE_STATUS_ERROR_CODES = new Set([
  'method_not_found',
  'forbidden',
  'invalid_argument'
])

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

type CapabilityProbeResult = {
  capabilities: NewWorktreeRuntimeCapabilities
  cache: 'authoritative' | 'transient'
  runtimeId: string | null
}

type CapabilityProbeRecord = {
  client: RpcClient | null
  connectionRevision: number
  runtimeRevision: number
  activationRevision: number
  cache: 'pending' | CapabilityProbeResult['cache']
  result: CapabilityProbeResult | null
  promise: Promise<CapabilityProbeResult>
}

type ConnectionRevision = {
  client: RpcClient | null
  revision: number
  runtimeRevision: number
  state: ReturnType<RpcClient['getState']> | null
  generation: number | null
  connectedAt: number | null
}

// Why: status.get is safe to replay and must settle before create, independently
// of slower provider probes, so ambiguous cutover retries are gated correctly.
export async function readNewWorktreeRuntimeCapabilities(
  client: RpcClient
): Promise<NewWorktreeRuntimeCapabilities> {
  return (await probeNewWorktreeRuntimeCapabilities(client)).capabilities
}

async function probeNewWorktreeRuntimeCapabilities(
  client: RpcClient
): Promise<CapabilityProbeResult> {
  for (let migrationRetry = 0; ; migrationRetry += 1) {
    try {
      const response = await client.sendRequest('status.get')
      if (!response.ok) {
        return {
          capabilities: UNSUPPORTED_CAPABILITIES,
          cache: AUTHORITATIVE_STATUS_ERROR_CODES.has(response.error.code)
            ? 'authoritative'
            : 'transient',
          runtimeId: response._meta.runtimeId
        }
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
        capabilities: {
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
        },
        cache: 'authoritative',
        runtimeId: response._meta.runtimeId
      }
    } catch (error) {
      if (!isLogicalClientCutoverError(error) || migrationRetry >= STATUS_CUTOVER_MAX_RETRIES) {
        return {
          capabilities: UNSUPPORTED_CAPABILITIES,
          cache: 'transient',
          runtimeId: null
        }
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
  const capabilityProbeRef = useRef<CapabilityProbeRecord | null>(null)
  const connectionRevisionRef = useRef<ConnectionRevision>(makeConnectionRevision(client))
  const enabledRef = useRef(enabled)
  const activationRevisionRef = useRef(0)
  if (connectionRevisionRef.current.client !== client) {
    connectionRevisionRef.current = makeConnectionRevision(client)
    capabilityProbeRef.current = null
    activationRevisionRef.current = 0
  } else if (enabled && !enabledRef.current) {
    activationRevisionRef.current += 1
  }
  enabledRef.current = enabled

  const getCapabilityProbe = useCallback((): CapabilityProbeRecord => {
    updateConnectionRevision(connectionRevisionRef.current)
    const current = capabilityProbeRef.current
    // Why: transient answers retry per recovery/activation, while authoritative
    // answers remain pinned until a connection can prove the runtime changed.
    if (
      current?.client === client &&
      ((current.cache === 'pending' &&
        current.connectionRevision === connectionRevisionRef.current.revision) ||
        (current.cache === 'authoritative' &&
          current.runtimeRevision === connectionRevisionRef.current.runtimeRevision) ||
        (current.cache === 'transient' &&
          current.connectionRevision === connectionRevisionRef.current.revision &&
          current.activationRevision === activationRevisionRef.current))
    ) {
      return current
    }
    const probe = client
      ? probeNewWorktreeRuntimeCapabilities(client)
      : Promise.resolve({
          capabilities: UNSUPPORTED_CAPABILITIES,
          cache: 'authoritative' as const,
          runtimeId: null
        })
    const record: CapabilityProbeRecord = {
      client,
      connectionRevision: connectionRevisionRef.current.revision,
      runtimeRevision: connectionRevisionRef.current.runtimeRevision,
      activationRevision: activationRevisionRef.current,
      cache: 'pending',
      result: null,
      // Why: the fresh answer always wins. Grafting the previous authoritative result
      // over a same-runtimeId re-probe would re-latch a negative the host has since
      // stopped giving (a permission grant landing inside one runtime).
      promise: probe
    }
    capabilityProbeRef.current = record
    void record.promise.then((result) => {
      if (capabilityProbeRef.current === record) {
        record.cache = result.cache
        record.result = result
      }
    })
    return record
  }, [client])

  useEffect(() => {
    if (!enabled || !client) {
      return
    }
    let stale = false
    let cancelRecovery: (() => void) | null = null
    const publish = (capabilities: NewWorktreeRuntimeCapabilities): void => {
      setTasksSupported(capabilities.tasksSupported)
      setHostPlatform(capabilities.hostPlatform)
    }
    // Why: a status.get that times out never moves connState, so no revision or
    // activation bump follows and nothing else would ever re-ask. Keep asking until
    // the host gives an answer worth pinning, then install it as the live record.
    const startRecovery = (): (() => void) =>
      startSettlingStatusProbe<CapabilityProbeResult>(
        () =>
          probeNewWorktreeRuntimeCapabilities(client).then((result) =>
            result.cache === 'authoritative'
              ? ({ settled: true, result } as const)
              : ({ settled: false, cutover: false } as const)
          ),
        (result) => {
          if (stale) {
            return
          }
          capabilityProbeRef.current = {
            client,
            connectionRevision: connectionRevisionRef.current.revision,
            runtimeRevision: connectionRevisionRef.current.runtimeRevision,
            activationRevision: activationRevisionRef.current,
            cache: result.cache,
            result,
            promise: Promise.resolve(result)
          }
          publish(result.capabilities)
        },
        { deferFirstAttempt: true }
      )
    const refresh = (): void => {
      cancelRecovery?.()
      cancelRecovery = null
      const record = getCapabilityProbe()
      void record.promise.then((result) => {
        if (stale || capabilityProbeRef.current !== record) {
          return
        }
        publish(result.capabilities)
        if (result.cache === 'transient') {
          cancelRecovery = startRecovery()
        }
      })
    }
    const unsubscribe = client.onStateChange(() => {
      const previousRevision = connectionRevisionRef.current.revision
      updateConnectionRevision(connectionRevisionRef.current)
      if (connectionRevisionRef.current.revision !== previousRevision) {
        refresh()
      }
    })
    refresh()
    return () => {
      stale = true
      cancelRecovery?.()
      unsubscribe()
    }
  }, [client, enabled, getCapabilityProbe, setTasksSupported])

  const getWorktreeCreateCutoverSupport = useCallback(
    () =>
      getCapabilityProbe().promise.then(
        ({ capabilities }) => capabilities.worktreeCreateIdempotency
      ),
    [getCapabilityProbe]
  )
  return { tasksSupported, hostPlatform, getWorktreeCreateCutoverSupport }
}

function makeConnectionRevision(client: RpcClient | null): ConnectionRevision {
  return {
    client,
    revision: 0,
    runtimeRevision: 0,
    state: client?.getState() ?? null,
    generation: readRpcClientGeneration(client),
    connectedAt: client?.getLastConnectedAt() ?? null
  }
}

function updateConnectionRevision(connection: ConnectionRevision): void {
  const { client } = connection
  if (!client) {
    return
  }
  const state = client.getState()
  const generation = readRpcClientGeneration(client)
  const connectedAt = client.getLastConnectedAt()
  const reconnected = state === 'connected' && connection.state !== 'connected'
  const migrated = generation !== null && generation !== connection.generation
  const connectionChanged = connectedAt !== null && connectedAt !== connection.connectedAt
  connection.state = state
  connection.generation = generation
  connection.connectedAt = connectedAt
  if (reconnected || migrated || connectionChanged) {
    connection.revision += 1
  }
  if (migrated || connectionChanged) {
    connection.runtimeRevision += 1
  }
}
