import { requestMobileWebHost } from './mobile-web-host-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

type Result = { outcome: 'accepted' | 'rejected' | 'unknown' } | { prepared: boolean }
type Payload = { workspaceId: string; sessionId: string; deadline: number }

export async function mutateMobileWebHostNativeChat<T extends Result>(
  requests: MobileWebOneShotRequestClient,
  action: 'sendMessage' | 'respond' | 'stop' | 'prepareCommit',
  payload: Payload,
  tabId: string,
  options?: MobileWebBridgeRequestOptions
): Promise<T> {
  const method = 'mobileWeb.nativeChat.mutate'
  const deadline = Math.min(
    payload.deadline,
    Date.now() + Math.min(15_000, options?.timeoutMs ?? 15_000)
  )
  const timeoutMs = Math.floor(deadline - Date.now())
  if (timeoutMs < 2_000) {
    return failed('rejected')
  }
  const { workspaceId, deadline: _deadline, ...mutation } = payload
  try {
    const result = await requestMobileWebHost(
      requests,
      method,
      workspaceId,
      { ...mutation, tabId, action, timeoutMs },
      { ...options, timeoutMs }
    )
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    const valid =
      action === 'prepareCommit'
        ? 'prepared' in result && typeof result.prepared === 'boolean'
        : 'outcome' in result &&
          ['accepted', 'rejected', 'unknown'].includes(String(result.outcome))
    if (!valid) {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    return result as T
  } catch (error) {
    // Never fall back after dispatch: the missing response may hide an accepted write.
    const rejected =
      error instanceof MobileWebBridgeClientError &&
      ['invalid_request', 'unsupported_capability', 'rate_limited', 'not_connected'].includes(
        error.code
      )
    return failed(rejected ? 'rejected' : 'unknown')
  }
  function failed(outcome: 'rejected' | 'unknown'): T {
    return (action === 'prepareCommit' ? { prepared: false } : { outcome }) as T
  }
}
