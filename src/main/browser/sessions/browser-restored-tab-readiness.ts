import type { BrowserCookieReimportSettings } from '../../../shared/browser/cookies/browser-cookie-reimport-settings'
import { reimportBrowserCookiesOnLaunch } from '../cookies/browser-profile-cookie-import'
import { whenBrowserExtensionSessionsLoaded } from '../extensions/profile-sessions/browser-extension-session-loader'

/** Restored tabs should get content scripts and launch-imported cookies; each wait is bounded so neither blocks launch. */
export async function whenBrowserSessionsReadyForRestoredTabs(
  settings: BrowserCookieReimportSettings
): Promise<void> {
  await Promise.all([
    whenBrowserExtensionSessionsLoaded(3_000),
    reimportBrowserCookiesOnLaunch(settings)
  ])
}
