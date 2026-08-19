import type { HostClientAcquisition } from './host-client-acquisition-registry'
import type { HostProfile } from './types'
import type { RpcClient } from './rpc-client'
import type { RpcClientContextValue } from './rpc-client-context-contract'

export type TransientHostClientLease = {
  client: RpcClient
  release: () => void
}

const ACQUIRE_TIMEOUT_MS = 12_000

type TurnWaiter = {
  grant: () => boolean
}

let turnActive = false
const turnWaiters: TurnWaiter[] = []

function releaseTurn(): void {
  while (turnWaiters.length > 0) {
    const waiter = turnWaiters.shift()
    if (waiter?.grant()) {
      return
    }
  }
  turnActive = false
}

function acquireTurn(signal?: AbortSignal): Promise<(() => void) | null> {
  if (signal?.aborted) {
    return Promise.resolve(null)
  }
  if (!turnActive) {
    turnActive = true
    return Promise.resolve(releaseTurn)
  }
  return new Promise((resolve) => {
    let waiting = true
    const onAbort = () => {
      if (waiting) {
        waiting = false
        resolve(null)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    turnWaiters.push({
      grant: () => {
        signal?.removeEventListener('abort', onAbort)
        if (!waiting || signal?.aborted) {
          return false
        }
        waiting = false
        resolve(releaseTurn)
        return true
      }
    })
  })
}

export function acquireTransientHostClient(
  context: RpcClientContextValue,
  host: HostProfile,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    onClientOwned?: (client: RpcClient) => void
  } = {}
): Promise<TransientHostClientLease | null> {
  if (options.signal?.aborted) {
    return Promise.resolve(null)
  }
  const acquisition: HostClientAcquisition = {}
  const acquisitionAbort = new AbortController()
  const abortAcquisition = () => acquisitionAbort.abort()
  options.signal?.addEventListener('abort', abortAcquisition, { once: true })
  const timeout = setTimeout(abortAcquisition, options.timeoutMs ?? ACQUIRE_TIMEOUT_MS)
  const cleanupAcquisition = () => {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortAcquisition)
  }
  return acquireTurn(acquisitionAbort.signal).then((unlock) => {
    if (!unlock) {
      cleanupAcquisition()
      return null
    }
    if (acquisitionAbort.signal.aborted) {
      unlock()
      cleanupAcquisition()
      return null
    }
    return new Promise((resolve) => {
      let settled = false
      let unsubscribeAllHosts = () => {}
      let unsubscribeHostState = () => {}
      const cleanupWait = () => {
        unsubscribeAllHosts()
        unsubscribeHostState()
        acquisitionAbort.signal.removeEventListener('abort', abortPending)
        cleanupAcquisition()
      }
      const releaseOwnership = () => {
        context.releaseAndCloseIfUnused(host.id, acquisition)
        unlock()
      }
      const finish = (client: RpcClient | null) => {
        if (settled) {
          return
        }
        settled = true
        cleanupWait()
        if (!client) {
          releaseOwnership()
          resolve(null)
          return
        }
        let released = false
        const release = () => {
          if (!released) {
            released = true
            options.signal?.removeEventListener('abort', release)
            releaseOwnership()
          }
        }
        if (options.signal?.aborted) {
          release()
          resolve(null)
          return
        }
        options.signal?.addEventListener('abort', release, { once: true })
        resolve({ client, release })
      }
      const abortPending = () => finish(null)
      acquisitionAbort.signal.addEventListener('abort', abortPending, { once: true })
      const readClient = () =>
        context.getAllClients().find((entry) => entry.hostId === host.id)?.client ?? null
      const settleFromContext = () => {
        const client = readClient()
        if (client) {
          options.onClientOwned?.(client)
        }
        const state = context.getKnownState(host.id)
        if (client && state === 'connected') {
          finish(client)
        } else if (state === 'auth-failed') {
          finish(null)
        }
      }
      try {
        unsubscribeAllHosts = context.subscribeAllHosts(settleFromContext)
        unsubscribeHostState = context.subscribeHostState(host.id, settleFromContext)
        const client = context.acquire(host.id, acquisition, host)
        if (client) {
          options.onClientOwned?.(client)
        }
        settleFromContext()
      } catch {
        finish(null)
      }
    })
  })
}
