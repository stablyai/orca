import { normalizeBrowserNavigationUrl } from '../../../../shared/browser/navigation/browser-url'
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
  // Keep what this host's own browser can do better.
  if (hasOwnBrowser && pairedDesktopTabMismatch(params) !== null) {
    return false
  }
  // With a browser to fall back on, only a desktop that can be asked is worth a request.
  return hasOwnBrowser
    ? host.getBrowserHostRequestRegistry().hasVolunteer()
    : canPlacePairedPage(host)
}

/** Why a paired desktop can't open this agent tab, or null when it can. */
export function pairedDesktopTabMismatch(
  params: { worktree?: string; url?: string; page?: string; split?: unknown } | undefined
): string | null {
  if (!params?.worktree) {
    return 'An Orca desktop opens agent tabs only inside a workspace; run tab create from one or pass --worktree.'
  }
  if (!isDesktopOpenableUrl(params.url)) {
    return 'An Orca desktop opens only http(s) pages for this host.'
  }
  if (params.split) {
    return "An Orca desktop can't open this host's tab as a split pane; drop --split."
  }
  if (params.page) {
    return "An Orca desktop can't open a tab under a page id this host picks."
  }
  return null
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
