import { getBrowserExtensionContextSignal } from './browser-extension-context-lifetime'
import { getHostSessionState } from './browser-extension-contexts'
import {
  BrowserExtensionApiError,
  type BrowserExtensionCaller
} from './browser-extension-namespace-registry'

export const MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2
const QUOTA_INTERVAL_MS = 1_000

type CaptureQuota = { expiresAt: number; remaining: number }
const quotaByLifetime = new WeakMap<AbortSignal, CaptureQuota>()

export function consumeBrowserExtensionCaptureQuota(caller: BrowserExtensionCaller): void {
  const state = getHostSessionState(caller.session)
  if (!state) {
    throw new BrowserExtensionApiError('Not an extension context')
  }
  if (caller.userGesture) {
    return
  }
  const lifetime = getBrowserExtensionContextSignal(state, caller.extension.id)
  const now = performance.now()
  let quota = quotaByLifetime.get(lifetime)
  if (!quota || now > quota.expiresAt) {
    quota = {
      expiresAt: now + QUOTA_INTERVAL_MS,
      remaining: MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
    }
    quotaByLifetime.set(lifetime, quota)
  }
  if (quota.remaining === 0) {
    throw new BrowserExtensionApiError(
      'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'
    )
  }
  quota.remaining -= 1
}
