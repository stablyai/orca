import { app } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import {
  isBrowserSitePermission,
  isBrowserSitePermissionDecision,
  type BrowserSitePermission,
  type BrowserSitePermissionDecision,
  type BrowserSitePermissionEntry
} from '../../shared/browser-site-permission'

export const BROWSER_SITE_PERMISSIONS_FILE_NAME = 'browser-site-permissions.json'

type SiteDecisions = BrowserSitePermissionEntry['decisions']
/** Browser profile id → origin → remembered answers. */
type StoredDecisions = Record<string, Record<string, SiteDecisions>>

let filePathOverride: string | null = null
let cached: { path: string; decisions: StoredDecisions } | null = null

// Why lazy: app.getPath('userData') throws before ready.
function storePath(): string {
  return filePathOverride ?? join(app.getPath('userData'), BROWSER_SITE_PERMISSIONS_FILE_NAME)
}

/** Answers belong to the Orca profile whose browser profiles they name. */
export function configureBrowserSitePermissionStore(profileDirectory: string): void {
  filePathOverride = join(profileDirectory, BROWSER_SITE_PERMISSIONS_FILE_NAME)
}

function parseSiteDecisions(value: unknown): SiteDecisions {
  const decisions: SiteDecisions = {}
  if (value && typeof value === 'object') {
    for (const [permission, decision] of Object.entries(value)) {
      if (isBrowserSitePermission(permission) && isBrowserSitePermissionDecision(decision)) {
        decisions[permission] = decision
      }
    }
  }
  return decisions
}

function parseStoredDecisions(raw: string): StoredDecisions {
  const parsed: unknown = JSON.parse(raw)
  const stored: StoredDecisions = {}
  if (!parsed || typeof parsed !== 'object' || !('profiles' in parsed)) {
    return stored
  }
  const { profiles } = parsed
  if (!profiles || typeof profiles !== 'object') {
    return stored
  }
  for (const [profileId, sites] of Object.entries(profiles)) {
    if (!sites || typeof sites !== 'object') {
      continue
    }
    const parsedSites: Record<string, SiteDecisions> = {}
    for (const [origin, decisions] of Object.entries(sites)) {
      const parsedDecisions = parseSiteDecisions(decisions)
      if (Object.keys(parsedDecisions).length > 0) {
        parsedSites[origin] = parsedDecisions
      }
    }
    stored[profileId] = parsedSites
  }
  return stored
}

function load(): StoredDecisions {
  let path: string
  try {
    path = storePath()
  } catch {
    return {}
  }
  if (cached?.path === path) {
    return cached.decisions
  }
  let decisions: StoredDecisions = {}
  try {
    decisions = parseStoredDecisions(readFileSync(path, 'utf-8'))
  } catch {
    // Missing or unreadable: every site is asked again.
  }
  cached = { path, decisions }
  return decisions
}

function persist(decisions: StoredDecisions): void {
  try {
    const path = storePath()
    cached = { path, decisions }
    mkdirSync(dirname(path), { recursive: true })
    writeFileDurableSync(
      durableWriteTempPath(path),
      path,
      `${JSON.stringify({ version: 1, profiles: decisions }, null, 2)}\n`
    )
  } catch (error) {
    // Why: the answer still holds for this run; failing the page's request would punish the user.
    console.error('[browser] Could not save site permissions:', error)
  }
}

export function getBrowserSitePermissionDecision(
  profileId: string,
  origin: string,
  permission: BrowserSitePermission
): BrowserSitePermissionDecision | undefined {
  return load()[profileId]?.[origin]?.[permission]
}

/** Null forgets the answer, so the site is asked again. */
export function setBrowserSitePermissionDecisions(
  profileId: string,
  origin: string,
  permissions: readonly BrowserSitePermission[],
  decision: BrowserSitePermissionDecision | null
): void {
  const stored = load()
  const sites = { ...stored[profileId] }
  const decisions = { ...sites[origin] }
  for (const permission of permissions) {
    if (decision) {
      decisions[permission] = decision
    } else {
      delete decisions[permission]
    }
  }
  if (Object.keys(decisions).length > 0) {
    sites[origin] = decisions
  } else {
    delete sites[origin]
  }
  persist({ ...stored, [profileId]: sites })
}

export function listBrowserSitePermissions(profileId: string): BrowserSitePermissionEntry[] {
  return Object.entries(load()[profileId] ?? {})
    .map(([origin, decisions]) => ({ origin, decisions }))
    .sort((a, b) => a.origin.localeCompare(b.origin))
}

export function forgetBrowserSitePermissions(profileId: string): void {
  const stored = load()
  if (!(profileId in stored)) {
    return
  }
  const { [profileId]: _forgotten, ...rest } = stored
  persist(rest)
}
