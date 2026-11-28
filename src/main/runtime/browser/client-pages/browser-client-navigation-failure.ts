import type { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { redactKagiSessionToken } from '../../../../shared/browser/navigation/browser-url'
import { browserClientPageRefusal } from './browser-client-page-refusal-copy'

const NAVIGATION_METHODS = new Set<BrowserClientAutomationMethod>([
  'browser.goto',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.certificate.proceed'
])

function containsPrivateNavigationUrl(detail: string): boolean {
  for (const match of detail.matchAll(/https:\/\//gi)) {
    // Inspect the whole suffix: splitting quoted URLs can expose the rest of a bearer.
    const candidate = detail.slice(match.index)
    if (redactKagiSessionToken(candidate) !== candidate) {
      return true
    }
  }
  return false
}

export function redactClientNavigationFailureDetail(
  method: BrowserClientAutomationMethod,
  params: Record<string, unknown>,
  detail?: string
) {
  const target = typeof params.url === 'string' ? params.url : ''
  const privateFailure =
    NAVIGATION_METHODS.has(method) &&
    (redactKagiSessionToken(target) !== target ||
      (detail !== undefined && containsPrivateNavigationUrl(detail)))
  return privateFailure ? 'Private navigation failed.' : detail
}

export function browserClientNavigationFailure(
  method: BrowserClientAutomationMethod,
  params: Record<string, unknown>,
  code: string,
  detail?: string
) {
  return browserClientPageRefusal(code, redactClientNavigationFailureDetail(method, params, detail))
}
