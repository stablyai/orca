import type { BrowserHttpAuthCredentials } from '../../shared/browser-http-auth'
import { browserManager } from './browser-manager'
import { browserPagePromptOrigin, openBrowserPagePrompt } from './browser-page-prompts'

function parseCredentials(value: unknown): BrowserHttpAuthCredentials | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'username' in value &&
    'password' in value &&
    typeof value.username === 'string' &&
    typeof value.password === 'string'
  ) {
    return { username: value.username, password: value.password }
  }
  return undefined
}

/** Leaving login unhandled lets Electron cancel the authentication challenge. */
export function handleBrowserGuestLogin(
  event: { preventDefault(): void },
  guest: Electron.WebContents | null,
  details: Electron.AuthenticationResponseDetails,
  authInfo: Electron.AuthInfo,
  callback: (username?: string, password?: string) => void
): void {
  // Proxy challenges use handleElectronProxyLogin; utility processes may have no guest.
  const origin = browserPagePromptOrigin(details.url)
  if (authInfo.isProxy || !guest || guest.isDestroyed() || !origin) {
    return
  }
  // Cross-origin subresources must not trigger password prompts.
  if (!details.isRequestForNavigation && origin !== browserPagePromptOrigin(guest.getURL())) {
    return
  }
  const opening = openBrowserPagePrompt({
    kind: 'http-auth',
    requester: guest,
    target: browserManager.resolvePagePromptTarget(guest),
    details: () => ({ origin, retry: !details.firstAuthAttempt }),
    // Coalesce protected resources sharing one challenge.
    coalesceKey: `${origin} ${authInfo.scheme} ${authInfo.realm}`,
    parseAnswer: parseCredentials,
    settle: (credentials) => {
      if (credentials) {
        callback(credentials.username, credentials.password)
      } else {
        callback()
      }
    }
  })
  if (opening === 'prompting') {
    event.preventDefault()
  }
}
