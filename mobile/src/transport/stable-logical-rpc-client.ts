import type { ConnectionState, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'
import {
  forwardMigrationDialState,
  type MigrationDialStateForwarder
} from './migration-dial-state-forwarder'
import { waitForAuthenticated } from './replacement-session-authentication'
import { projectMobileRpcRequestParams } from './mobile-rpc-request-projection'
import { LogicalClientConnectionPath } from './logical-client-connection-path'
import type { RelayHostReachability } from './relay-host-reachability'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { LogicalClientSuspendedError } from './logical-client-suspended-error'

export type MobileConnectionPath = 'lan' | 'tailscale' | 'relay'

export class LogicalClientCutoverError extends Error {
  constructor(cause?: unknown) {
    super('RPC interrupted by connection migration', { cause })
    if (isRpcDeliveryUnknown(cause)) {
      markRpcDeliveryUnknown(this)
    }
  }
}

// Why: instanceof can miss across bundle copies, so also match by message.
export function isLogicalClientCutoverError(error: unknown): boolean {
  return (
    error instanceof LogicalClientCutoverError ||
    (error instanceof Error && error.message === 'RPC interrupted by connection migration')
  )
}

type SubscriptionRecord = {
  method: string
  params: unknown
  listener: (result: unknown) => void
  options?: Parameters<RpcClient['subscribe']>[3]
  disposePhysical: (() => void) | null
  cancelled: boolean
}

export type StableLogicalRpcClient = RpcClient & {
  migrateTo(
    session: RpcClient,
    path: MobileConnectionPath,
    timeoutMs?: number,
    // Allow a racing caller to withdraw after replacement authentication, before closing the active winner.
    shouldAbort?: () => boolean
  ): Promise<void>
  suspendActiveSession(): void
  getActivePath(): MobileConnectionPath
  // The path the user is waiting on while migration or scheduled recovery is active.
  getPendingPath(): MobileConnectionPath | null
  setRecoveryPath(path: MobileConnectionPath | null, attempt?: number): void
  setRecoveryAttempt(attempt: number): void
  // Latched when the desktop has repeatedly refused this device's relay credential.
  setPairingRejected(rejected: boolean): void
  isPairingRejected(): boolean
  // Latch authoritative relay close reasons or repeated identical failures naming the desktop’s state.
  setRelayHostReachability(reachability: RelayHostReachability): void
  getRelayHostReachability(): RelayHostReachability
  // Recovery attempts share this signal so status-only changes rerender.
  onConnectionPathChange(listener: () => void): () => void
  getGeneration(): number
}

export function createStableLogicalRpcClient(
  initialSession: RpcClient,
  initialPath: MobileConnectionPath
): StableLogicalRpcClient {
  let activeSession = initialSession
  let activePath = initialPath
  let generation = 1
  let closed = false
  let suspended = false
  let nextSubscriptionId = 0
  let activeStateUnsubscribe: (() => void) | null = null
  const subscriptions = new Map<number, SubscriptionRecord>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let state = initialSession.getState()
  const connectionPath = new LogicalClientConnectionPath(() => state === 'connected')

  bindActiveState(initialSession, generation)

  const logical: StableLogicalRpcClient = {
    sendRequest(method, params, options) {
      if (closed) {
        return Promise.reject(new Error('Client closed'))
      }
      if (suspended) {
        return Promise.reject(new LogicalClientSuspendedError())
      }
      const requestGeneration = generation
      const session = activeSession
      return new Promise<RpcResponse>((resolve, reject) => {
        void session
          .sendRequest(method, projectMobileRpcRequestParams(method, params), options)
          .then(
            (response) => {
              // A correlated response is definitive even if close/cutover won the
              // callback race after the physical promise had already settled.
              resolve(response)
            },
            (error: unknown) => {
              // Keep the physical error as cause: only that layer knows whether the frame reached the wire.
              reject(
                requestGeneration !== generation
                  ? new LogicalClientCutoverError(error)
                  : // Suspension retires the session under requests it never sent.
                    suspended && !isRpcDeliveryUnknown(error)
                    ? new LogicalClientSuspendedError()
                    : error
              )
            }
          )
      })
    },

    subscribe(method, params, listener, options) {
      if (closed) {
        return () => {}
      }
      const id = ++nextSubscriptionId
      const record: SubscriptionRecord = {
        method,
        params,
        listener,
        options,
        disposePhysical: null,
        cancelled: false
      }
      subscriptions.set(id, record)
      if (!suspended) {
        attachSubscription(record, activeSession, generation)
      }
      return () => {
        if (record.cancelled) {
          return
        }
        record.cancelled = true
        record.disposePhysical?.()
        record.disposePhysical = null
        subscriptions.delete(id)
      }
    },

    updateTerminalSubscriptionViewport(terminal, viewport) {
      for (const record of subscriptions.values()) {
        if (
          record.params &&
          typeof record.params === 'object' &&
          'terminal' in record.params &&
          record.params.terminal === terminal
        ) {
          record.params = { ...record.params, viewport }
        }
      }
      if (!suspended) {
        activeSession.updateTerminalSubscriptionViewport(terminal, viewport)
      }
    },

    getState: () => state,
    getReconnectAttempt: () => connectionPath.reconnectAttempt(activeSession.getReconnectAttempt()),
    getLastConnectedAt: () => activeSession.getLastConnectedAt(),
    getLastInboundAt: () => activeSession.getLastInboundAt?.() ?? null,
    onStateChange(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    notifyForeground: (reason) => {
      if (!suspended) {
        activeSession.notifyForeground(reason)
      }
    },
    probeLivenessNow: () => {
      if (!suspended) {
        activeSession.probeLivenessNow?.()
      }
    },
    close() {
      if (closed) {
        return
      }
      closed = true
      activeStateUnsubscribe?.()
      activeStateUnsubscribe = null
      for (const record of subscriptions.values()) {
        record.disposePhysical?.()
      }
      subscriptions.clear()
      // Let physical close distinguish unwritten requests from delivery-unknown written requests.
      activeSession.close()
      publishState('disconnected')
    },

    suspendActiveSession() {
      if (closed || suspended) {
        return
      }
      suspended = true
      activeStateUnsubscribe?.()
      activeStateUnsubscribe = null
      for (const record of subscriptions.values()) {
        record.disposePhysical?.()
        record.disposePhysical = null
      }
      // Physical close must preserve delivery uncertainty for requests interrupted by suspension.
      activeSession.close()
      publishState('disconnected')
    },

    async migrateTo(nextSession, path, timeoutMs = 12_000, shouldAbort) {
      if (closed) {
        nextSession.close()
        throw new Error('Client closed')
      }
      // Name the pending path even when the old session is already reconnecting and needs no forwarded phase.
      if (suspended || state !== 'connected') {
        connectionPath.setMigration(path)
      }
      const forwarder = forwardMigrationDialState({
        session: nextSession,
        snapshot: () => ({ state, suspended }),
        // Ignore late dial phases after close so they cannot revive the disconnected state.
        publish: (next) => {
          if (!closed) {
            publishState(next)
          }
        }
      })
      try {
        await waitForAuthenticated(nextSession, timeoutMs)
        if (closed) {
          throw new Error('Client closed')
        }
        // Respect first-authenticated-wins; a stale replacement must not close a live winner.
        if (shouldAbort?.()) {
          throw new Error('migration superseded')
        }
      } catch (error) {
        endDialForwarding(forwarder, true)
        nextSession.close()
        throw error
      }
      // Unbind first so the replacement has exactly one state publisher.
      endDialForwarding(forwarder, false)
      const previous = activeSession
      const previousStateUnsubscribe = activeStateUnsubscribe
      const nextGeneration = generation + 1

      // Replay before closing the old session; fence callbacks until this generation becomes current.
      for (const record of subscriptions.values()) {
        const disposePrevious = record.disposePhysical
        attachSubscription(record, nextSession, nextGeneration)
        disposePrevious?.()
      }
      generation = nextGeneration
      activeSession = nextSession
      activePath = path
      suspended = false
      previousStateUnsubscribe?.()
      bindActiveState(nextSession, nextGeneration)
      state = nextSession.getState()
      connectionPath.clearAfterConnected()
      for (const listener of stateListeners) {
        listener(state)
      }
      // Only the physical sender knows whether a pending request reached the wire.
      previous.close()
    },

    getActivePath: () => activePath,
    // Clear pending path when the previous session recovers mid-dial.
    getPendingPath: () => connectionPath.pending(),
    setRecoveryPath: (path, attempt) => connectionPath.setRecovery(path, attempt),
    setRecoveryAttempt: (attempt) => connectionPath.setRecoveryAttempt(attempt),
    setPairingRejected: (rejected) => connectionPath.setPairingRejected(rejected),
    isPairingRejected: () => connectionPath.isPairingRejected(),
    setRelayHostReachability: (reachability) =>
      connectionPath.setRelayHostReachability(reachability),
    getRelayHostReachability: () => connectionPath.getRelayHostReachability(),
    onConnectionPathChange: (listener) => connectionPath.subscribe(listener),
    getGeneration: () => generation
  }

  return logical

  function endDialForwarding(forwarder: MigrationDialStateForwarder, failed: boolean): void {
    forwarder.stop()
    if (failed) {
      connectionPath.setMigration(null)
    }
    // Undo only forwarded phases; a connected state from the previous session outranks the failed dial.
    if (failed && forwarder.forwarded() && state !== 'connected') {
      publishState('disconnected')
    }
  }

  function attachSubscription(
    record: SubscriptionRecord,
    session: RpcClient,
    subscriptionGeneration: number
  ): void {
    record.disposePhysical = session.subscribe(
      record.method,
      record.params,
      (result) => {
        if (!closed && !record.cancelled && generation === subscriptionGeneration) {
          record.listener(result)
        }
      },
      record.options
    )
  }

  function bindActiveState(session: RpcClient, sessionGeneration: number): void {
    activeStateUnsubscribe = session.onStateChange((next) => {
      if (!closed && generation === sessionGeneration && session === activeSession) {
        publishState(next)
      }
    })
  }

  function publishState(next: ConnectionState): void {
    if (state === next) {
      return
    }
    state = next
    if (next === 'connected') {
      connectionPath.clearAfterConnected()
    }
    for (const listener of stateListeners) {
      listener(next)
    }
  }
}
