import { redactKagiSessionToken } from '../../../shared/browser/navigation/browser-url'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { BrowserError } from '../browser-error'

export function browserNavigationError(error: unknown, ...urls: string[]): Error {
  const failedUrl = isRecord(error) && typeof error.url === 'string' ? error.url : ''
  return [...urls, failedUrl].some((url) => redactKagiSessionToken(url) !== url)
    ? new BrowserError('browser_navigation_failed', 'Private navigation failed.')
    : error instanceof Error
      ? error
      : new Error('The browser page could not load')
}
