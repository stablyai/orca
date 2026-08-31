import type { ConnectionState, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'
import {
  forwardMigrationDialState,
  type MigrationDialStateForwarder
} from './migration-dial-state-forwarder'
import { waitForAuthenticated } from './replacement-session-authentication'
import { projectMobileRpcRequestParams } from './mobile-rpc-request-projection'
import { LogicalClientConnectionPath } from './logical-client-connection-path'

export type MobileConnectionPath = 'lan' | 'tailscale' | 'relay'

export class LogicalClientCutoverError extends Error {
  constructor() {
    super('RPC interrupted by connection migration')
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

type PendingRequest = {
  reject: (error: Error) => void
}

export type StableLogicalRpcClient = RpcClient & {
  migrateTo(
    session: RpcClient,
    path: MobileConnectionPath,
    timeoutMs?: number,
    // Checked after the replacement authenticates, before the swap — lets a racing
    // caller withdraw when another path won while this dial was in flight.
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
  const pendingRequests = new Set<PendingRequest>()
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
        return Promise.reject(new Error('Client suspended'))
      }
      const requestGeneration = generation
      const session = activeSession
      return new Promise<RpcResponse>((resolve, reject) => {
        const pending = { reject }
        pendingRequests.add(pending)
        void session
          .sendRequest(method, projectMobileRpcRequestParams(method, params), options)
          .then(
            (response) => {
              pendingRequests.delete(pending)
              if (closed) {
                reject(new Error('Client closed'))
              } else if (requestGeneration !== generation) {
                reject(new LogicalClientCutoverError())
              } else {
                resolve(response)
              }
            },
            (error: unknown) => {
              pendingRequests.delete(pending)
              reject(error)
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
      // Why: let the physical close settle in-flight requests — it knows which
      // frames were written and marks those delivery-unknown; a blanket local
      // reject would erase that distinction.
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
      // Why: let the physical close settle in-flight requests — it knows which
      // frames were written and marks those delivery-unknown (a suspend can cut
      // over a half-open relay whose sends may already be delivered).
      activeSession.close()
      publishState('disconnected')
    },

    async migrateTo(nextSession, path, timeoutMs = 12_000, shouldAbort) {
      if (closed) {
        nextSession.close()
        throw new Error('Client closed')
      }
      // Why: naming the dial is independent of narrating it. The dominant relay case
      // (direct dial fails) sits in 'reconnecting' — already amber, so forwarding adds
      // nothing, but the user still has no idea relay is what's being tried.
      if (suspended || state !== 'connected') {
        connectionPath.setMigration(path)
      }
      const forwarder = forwardMigrationDialState({
        session: nextSession,
        snapshot: () => ({ state, suspended }),
        // Why: close() during the dial already published 'disconnected'; a late
        // forwarded phase must not resurrect a closed client's dot.
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
        // Why: cutting over anyway would close a live winner and strand the user
        // on the slower path (the happy-eyeballs race is first-authenticated-wins).
        if (shouldAbort?.()) {
          throw new Error('migration superseded')
        }
      } catch (error) {
        endDialForwarding(forwarder, true)
        nextSession.close()
        throw error
      }
      // Why: unbind before bindActiveState so the replacement has exactly one publisher.
      endDialForwarding(forwarder, false)
      const previous = activeSession
      const previousStateUnsubscribe = activeStateUnsubscribe
      const nextGeneration = generation + 1

      // Why: replay on the authenticated replacement before closing the old
      // session, but fence callbacks until the generation becomes current.
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
      for (const pending of pendingRequests) {
        pending.reject(new LogicalClientCutoverError())
      }
      pendingRequests.clear()
      state = nextSession.getState()
      connectionPath.clearAfterConnected()
      for (const listener of stateListeners) {
        listener(state)
      }
      previous.close()
    },

    getActivePath: () => activePath,
    // Why: a previous session that recovers mid-dial makes the pending path a lie —
    // once we're connected the user is no longer waiting on anything.
    getPendingPath: () => connectionPath.pending(),
    setRecoveryPath: (path, attempt) => connectionPath.setRecovery(path, attempt),
    setRecoveryAttempt: (attempt) => connectionPath.setRecoveryAttempt(attempt),
    setPairingRejected: (rejected) => connectionPath.setPairingRejected(rejected),
    isPairingRejected: () => connectionPath.isPairingRejected(),
    onConnectionPathChange: (listener) => connectionPath.subscribe(listener),
    getGeneration: () => generation
  }

  return logical

  function endDialForwarding(forwarder: MigrationDialStateForwarder, failed: boolean): void {
    forwarder.stop()
    if (failed) {
      connectionPath.setMigration(null)
    }
    // Why: only walk back phases we published ourselves — a 'connected' here came from
    // the still-live previous session and outranks the dead dial.
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
