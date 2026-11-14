import type { ChromeWebRequestDetails } from './browser-extension-web-request-details'
import { matchesExtensionMatchPattern } from '../permissions/browser-extension-match-pattern'

/** Main-side pre-filter against one listener's chrome.webRequest.RequestFilter. */
export function webRequestFilterMatches(
  filter: unknown,
  details: ChromeWebRequestDetails
): boolean {
  if (filter === null || typeof filter !== 'object') {
    return true
  }
  const fields = new Map(Object.entries(filter))
  const urls = fields.get('urls')
  if (
    Array.isArray(urls) &&
    !urls.some(
      (pattern) => typeof pattern === 'string' && matchesExtensionMatchPattern(pattern, details.url)
    )
  ) {
    return false
  }
  const types = fields.get('types')
  if (Array.isArray(types) && !types.includes(details.type)) {
    return false
  }
  const tabId = fields.get('tabId')
  const windowId = fields.get('windowId')
  return (
    (typeof tabId !== 'number' || tabId === details.tabId) &&
    (typeof windowId !== 'number' || windowId === details.windowId)
  )
}
