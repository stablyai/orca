import type { ConnectionState, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'

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
  migrateTo(session: RpcClient, path: MobileConnectionPath, timeoutMs?: number): Promise<void>
  suspendActiveSession(): void
  getActivePath(): MobileConnectionPath
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
        void session.sendRequest(method, params, options).then(
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
    getReconnectAttempt: () => activeSession.getReconnectAttempt(),
    getLastConnectedAt: () => activeSession.getLastConnectedAt(),
    onStateChange(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    notifyForeground: () => {
      if (!suspended) {
        activeSession.notifyForeground()
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

    async migrateTo(nextSession, path, timeoutMs = 12_000) {
      if (closed) {
        nextSession.close()
        throw new Error('Client closed')
      }
      try {
        await waitForAuthenticated(nextSession, timeoutMs)
      } catch (error) {
        nextSession.close()
        throw error
      }
      if (closed) {
        nextSession.close()
        throw new Error('Client closed')
      }
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
      for (const listener of stateListeners) {
        listener(state)
      }
      previous.close()
    },

    getActivePath: () => activePath,
    getGeneration: () => generation
  }

  return logical

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
    for (const listener of stateListeners) {
      listener(next)
    }
  }
}

function waitForAuthenticated(session: RpcClient, timeoutMs: number): Promise<void> {
  if (session.getState() === 'connected') {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = session.onStateChange((state) => {
      if (state === 'connected') {
        finish()
        resolve()
      } else if (state === 'auth-failed' || state === 'disconnected') {
        finish()
        reject(new Error(`replacement session ${state}`))
      }
    })
    timer = setTimeout(() => {
      finish()
      reject(new Error('replacement session authentication timed out'))
    }, timeoutMs)

    function finish(): void {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      unsubscribe()
    }
  })
}
