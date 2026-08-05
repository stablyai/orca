import type { RpcClient } from './rpc-client'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { isRecoverableRpcError } from './recoverable-rpc-error'

export const FORCE_RECONNECT_TIMEOUT_MS = 15_000

// Why: recoverable rejections can settle synchronously (suspended client, relay
// cutover races); pacing fast failures keeps the retry loop from spinning the
// RN event loop for the whole budget while leaving slow real waits unpenalized.
const RETRY_PAUSE_MS = 250

export async function verifyForceReconnectRpcHealth(
  client: RpcClient,
  deadline = Date.now() + FORCE_RECONNECT_TIMEOUT_MS
): Promise<void> {
  let lastError: unknown = null
  for (;;) {
    const timeoutMs = deadline - Date.now()
    if (timeoutMs <= 0) {
      throw lastError ?? new Error('Force Reconnect health check timed out')
    }
    const attemptStartedAt = Date.now()
    try {
      const response = await client.sendRequest(
        'worktree.ps',
        { limit: 1 },
        {
          timeoutMs,
          budgetSpansConnect: true,
          strictDeadline: true,
          applicationHealthProbe: true
        }
      )
      // Why: any resolved reply — success or application error — round-tripped the
      // control channel, which is what this check verifies; failing on ok:false would
      // retire a healthy replacement over a host-side application fault. Auth
      // rejections never resolve a request (both transports divert them), but guard
      // anyway so a future transport cannot report a dead pairing as recovered.
      if (!response.ok && response.error.code === 'unauthorized') {
        throw new Error(response.error.message)
      }
      if (client.getRpcUnresponsiveSince?.() != null) {
        throw new Error('Application RPC channel is still not responding')
      }
      return
    } catch (error) {
      const state = client.getState()
      if (state === 'auth-failed' || !isRecoverableHealthError(error, state)) {
        throw error
      }
      lastError = error
      if (state === 'disconnected') {
        await waitForReconnectState(client, deadline, error)
      } else if (Date.now() - attemptStartedAt < RETRY_PAUSE_MS) {
        await pauseBeforeRetry(deadline)
      }
    }
  }
}

function pauseBeforeRetry(deadline: number): Promise<void> {
  const delayMs = Math.min(RETRY_PAUSE_MS, deadline - Date.now())
  if (delayMs <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function isRecoverableHealthError(
  error: unknown,
  state: ReturnType<RpcClient['getState']>
): boolean {
  return state === 'reconnecting' || isRecoverableRpcError(error) || isRpcDeliveryUnknown(error)
}

function waitForReconnectState(
  client: RpcClient,
  deadline: number,
  lastError: unknown
): Promise<void> {
  if (client.getState() !== 'disconnected') {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timeoutMs = deadline - Date.now()
    if (timeoutMs <= 0) {
      reject(lastError)
      return
    }
    const timer = setTimeout(() => finish(() => reject(lastError)), timeoutMs)
    const unsubscribe = client.onStateChange((state) => {
      if (state === 'disconnected') {
        return
      }
      finish(state === 'auth-failed' ? () => reject(lastError) : resolve)
    })
    const currentState = client.getState()
    if (currentState !== 'disconnected') {
      finish(currentState === 'auth-failed' ? () => reject(lastError) : resolve)
    }

    function finish(settle: () => void): void {
      clearTimeout(timer)
      unsubscribe()
      settle()
    }
  })
}
