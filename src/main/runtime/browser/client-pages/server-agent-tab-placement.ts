import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/browser/browser-blank-page'
import {
  assertClientOpenableUrl,
  canPlacePairedPage,
  type BrowserClientPageOpeningHost
} from './browser-client-page-opening'

/** A tab this server's own agents open goes on a paired desktop when one can host it (#41682). */
export function opensOnPairedDesktop(
  host: Pick<
    BrowserClientPageOpeningHost,
    'getBrowserHostLeaseRegistry' | 'getBrowserHostRequestRegistry'
  >,
  params:
    | { placement?: unknown; worktree?: string; url?: string; page?: string; split?: unknown }
    | undefined,
  caller: { pairedDeviceId?: string; opensPageLink?: boolean } | undefined,
  hasOwnBrowser: boolean
): boolean {
  // Paired callers choose their own placement, and a page link opens beside its opener.
  if (params?.placement || caller?.pairedDeviceId || caller?.opensPageLink) {
    return false
  }
  // Keep what this host's own browser can do better: unscoped tabs, local URLs, named pages it
  // may already hold, and splits a desktop page cannot open as.
  if (
    hasOwnBrowser &&
    (!params?.worktree || !isDesktopOpenableUrl(params.url) || params.page || params.split)
  ) {
    return false
  }
  // With a browser to fall back on, only a desktop that can be asked is worth a request.
  return hasOwnBrowser
    ? host.getBrowserHostRequestRegistry().hasVolunteer()
    : canPlacePairedPage(host)
}

// Match what the desktop opens, so `localhost:3000` counts as the web URL it becomes there.
function isDesktopOpenableUrl(url: string | undefined): boolean {
  const normalized = url === undefined ? null : normalizeBrowserNavigationUrl(url)
  if (url === undefined || normalized === ORCA_BROWSER_BLANK_URL) {
    return true
  }
  try {
    assertClientOpenableUrl(normalized ?? url)
    return true
  } catch {
    return false
  }
}
