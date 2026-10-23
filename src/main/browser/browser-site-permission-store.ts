import {
  isBrowserSitePermission,
  isBrowserSitePermissionDecision,
  type BrowserSitePermission,
  type BrowserSitePermissionDecision,
  type BrowserSitePermissionEntry
} from '../../shared/browser-site-permission'
import { createBrowserProfileSiteStore } from './browser-profile-site-store'

export const BROWSER_SITE_PERMISSIONS_FILE_NAME = 'browser-site-permissions.json'

type SiteDecisions = BrowserSitePermissionEntry['decisions']

function parseSiteDecisions(value: unknown): SiteDecisions | null {
  const decisions: SiteDecisions = {}
  if (value && typeof value === 'object') {
    for (const [permission, decision] of Object.entries(value)) {
      if (isBrowserSitePermission(permission) && isBrowserSitePermissionDecision(decision)) {
        decisions[permission] = decision
      }
    }
  }
  return Object.keys(decisions).length > 0 ? decisions : null
}

/** Browser profile id → origin → remembered answers. */
const store = createBrowserProfileSiteStore({
  fileName: BROWSER_SITE_PERMISSIONS_FILE_NAME,
  description: 'site permissions',
  parseEntry: parseSiteDecisions
})

/** Answers belong to the Orca profile whose browser profiles they name. */
export function configureBrowserSitePermissionStore(profileDirectory: string): void {
  store.configure(profileDirectory)
}

export function getBrowserSitePermissionDecision(
  profileId: string,
  origin: string,
  permission: BrowserSitePermission
): BrowserSitePermissionDecision | undefined {
  return store.get(profileId, origin)?.[permission]
}

/** Null forgets the answer, so the site is asked again. */
export function setBrowserSitePermissionDecisions(
  profileId: string,
  origin: string,
  permissions: readonly BrowserSitePermission[],
  decision: BrowserSitePermissionDecision | null
): void {
  const decisions = { ...store.get(profileId, origin) }
  for (const permission of permissions) {
    if (decision) {
      decisions[permission] = decision
    } else {
      delete decisions[permission]
    }
  }
  store.set(profileId, origin, Object.keys(decisions).length > 0 ? decisions : null)
}

export function listBrowserSitePermissions(profileId: string): BrowserSitePermissionEntry[] {
  return store.list(profileId).map(([origin, decisions]) => ({ origin, decisions }))
}

export function forgetBrowserSitePermissions(profileId: string): void {
  store.forget(profileId)
}
