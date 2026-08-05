import type { ConnectionState } from './types'
import { RecoverableRpcError } from './recoverable-rpc-error'

export function waitForMobileRelayRpcConnected(args: {
  getState: () => ConnectionState
  subscribe: (listener: (state: ConnectionState) => void) => () => void
  timeoutMs: number
}): Promise<void> {
  const state = args.getState()
  if (state === 'connected') {
    return Promise.resolve()
  }
  if (state === 'disconnected' || state === 'auth-failed') {
    return Promise.reject(sessionStateError(state))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new RecoverableRpcError('relay session connection timed out'))
    }, args.timeoutMs)
    const unsubscribe = args.subscribe((next) => {
      if (next === 'connected') {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      } else if (next === 'disconnected' || next === 'auth-failed') {
        clearTimeout(timer)
        unsubscribe()
        reject(sessionStateError(next))
      }
    })
  })
}

function sessionStateError(state: 'disconnected' | 'auth-failed'): Error {
  const message = `relay session ${state}`
  return state === 'disconnected' ? new RecoverableRpcError(message) : new Error(message)
}
