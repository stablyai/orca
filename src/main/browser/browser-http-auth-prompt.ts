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

/**
 * App `login` handler for sites in browser tabs. Returning without preventDefault keeps Electron's
 * default, which cancels the challenge, so the page gets the site's 401 page.
 */
export function handleBrowserGuestLogin(
  event: { preventDefault(): void },
  guest: Electron.WebContents | null,
  details: Electron.AuthenticationResponseDetails,
  authInfo: Electron.AuthInfo,
  callback: (username?: string, password?: string) => void
): void {
  // Why: proxy challenges belong to handleElectronProxyLogin; a null guest is a utility process.
  const origin = browserPagePromptOrigin(details.url)
  if (authInfo.isProxy || !guest || guest.isDestroyed() || !origin) {
    return
  }
  // Why: as in Chrome, an embedded image or script from another site must not ask for a password.
  if (!details.isRequestForNavigation && origin !== browserPagePromptOrigin(guest.getURL())) {
    return
  }
  const opening = openBrowserPagePrompt({
    kind: 'http-auth',
    requester: guest,
    target: browserManager.resolvePagePromptTarget(guest),
    details: () => ({ origin, retry: !details.firstAuthAttempt }),
    // Why: a page loading ten protected images gets one question.
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
