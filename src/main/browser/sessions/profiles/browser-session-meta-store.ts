import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'

export type PendingBrowserCookieImport =
  | string
  | {
      format: string
      path: string
    }

// Session identity comes from the running engine; discard legacy top-level UA fields.
// Retain per-profile userAgentMode for rollback and migration notices.
export type BrowserSessionMeta = {
  defaultSource: BrowserSessionProfile['source']
  pendingCookieDbPath: string | null
  pendingCookieImports: Record<string, PendingBrowserCookieImport>
  profiles: BrowserSessionProfile[]
  /** Browser-profile id ('default' included) → enabled extension ids. Kept off the profile wire shape. */
  enabledExtensionIdsByProfileId: Record<string, string[]>
  /** Browser-profile id → extension ids pinned to the browser toolbar, in pin order. */
  pinnedExtensionIdsByProfileId: Record<string, string[]>
}

export const BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'

function parseEnabledExtensionIds(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result
  }
  for (const [profileId, ids] of Object.entries(value)) {
    if (Array.isArray(ids)) {
      result[profileId] = ids.filter((id): id is string => typeof id === 'string')
    }
  }
  return result
}

const lastReadSucceededByPath = new Map<string, boolean>()
/** Enabled extensions per metadata file as last read; every write goes through persistBrowserSessionMeta. */
const enabledExtensionIdsByPath = new Map<
  string,
  BrowserSessionMeta['enabledExtensionIdsByProfileId']
>()

function copyIdLists(byProfileId: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(byProfileId).map(([id, ids]) => [id, [...ids]]))
}

// Resolve the path inside the load error boundary.
export function loadBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string
): BrowserSessionMeta {
  let path: string | null = null
  try {
    path = resolveMetadataPath()
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw)
    const legacyPendingCookieDbPath =
      typeof data?.pendingCookieDbPath === 'string' ? data.pendingCookieDbPath : null
    const pendingCookieImports: Record<string, PendingBrowserCookieImport> = {}
    if (data && typeof data.pendingCookieImports === 'object' && data.pendingCookieImports) {
      for (const [partition, entry] of Object.entries(data.pendingCookieImports)) {
        if (
          typeof entry === 'string' ||
          (entry &&
            typeof entry === 'object' &&
            typeof (entry as { format?: unknown }).format === 'string' &&
            typeof (entry as { path?: unknown }).path === 'string')
        ) {
          pendingCookieImports[partition] = entry as PendingBrowserCookieImport
        }
      }
    }
    if (legacyPendingCookieDbPath && !pendingCookieImports[defaultPartition]) {
      pendingCookieImports[defaultPartition] = legacyPendingCookieDbPath
    }
    const meta: BrowserSessionMeta = {
      defaultSource: data?.defaultSource ?? null,
      pendingCookieDbPath: legacyPendingCookieDbPath,
      pendingCookieImports,
      profiles: Array.isArray(data?.profiles) ? data.profiles : [],
      enabledExtensionIdsByProfileId: parseEnabledExtensionIds(
        data?.enabledExtensionIdsByProfileId
      ),
      pinnedExtensionIdsByProfileId: parseEnabledExtensionIds(data?.pinnedExtensionIdsByProfileId)
    }
    // Only a read that worked is kept: a brief lock must not read as "nothing enabled" for the run.
    enabledExtensionIdsByPath.set(path, copyIdLists(meta.enabledExtensionIdsByProfileId))
    // A malformed profile list is not proof that its profiles were deleted.
    lastReadSucceededByPath.set(
      path,
      typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        (data.profiles === undefined || Array.isArray(data.profiles))
    )
    return meta
  } catch {
    if (path !== null) {
      lastReadSucceededByPath.set(path, false)
    }
    return {
      defaultSource: null,
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: [],
      enabledExtensionIdsByProfileId: {},
      pinnedExtensionIdsByProfileId: {}
    }
  }
}

/** Whether the latest read of this metadata file succeeded; a failed read looks like "no profiles". */
export function didReadBrowserSessionMeta(metadataPath: string): boolean {
  return lastReadSucceededByPath.get(metadataPath) === true
}

/**
 * A profile's enabled extensions from the last successful read, or null before one. Why: a profile
 * reattaching after it went idle shouldn't reread every profile's metadata.
 */
export function getCachedBrowserExtensionEnabledIds(
  metadataPath: string,
  profileId: string
): string[] | null {
  const byProfileId = enabledExtensionIdsByPath.get(metadataPath)
  return byProfileId ? [...(byProfileId[profileId] ?? [])] : null
}

// Write to a temporary file so an interrupted write leaves the existing metadata intact.
export function persistBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string,
  updates: Partial<BrowserSessionMeta>
): void {
  try {
    const existing = loadBrowserSessionMeta(resolveMetadataPath, defaultPartition)
    const tmpPath = `${resolveMetadataPath()}.tmp`
    mkdirSync(dirname(resolveMetadataPath()), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify({ ...existing, ...updates }))
    renameSync(tmpPath, resolveMetadataPath())
    // After the rename: the read above cached the contents this write replaced.
    enabledExtensionIdsByPath.delete(resolveMetadataPath())
  } catch {}
}

/** Meta updates that forget a deleted profile: its staged cookie import and its enabled extensions. */
export function forgetBrowserSessionProfileMeta(
  meta: BrowserSessionMeta,
  profile: Pick<BrowserSessionProfile, 'id' | 'partition'>,
  defaultPartition: string
): Partial<BrowserSessionMeta> {
  const pendingCookieImports = { ...meta.pendingCookieImports }
  delete pendingCookieImports[profile.partition]
  const defaultPendingImport = pendingCookieImports[defaultPartition]
  const enabledExtensionIdsByProfileId = { ...meta.enabledExtensionIdsByProfileId }
  delete enabledExtensionIdsByProfileId[profile.id]
  const pinnedExtensionIdsByProfileId = { ...meta.pinnedExtensionIdsByProfileId }
  delete pinnedExtensionIdsByProfileId[profile.id]
  return {
    pendingCookieImports,
    pendingCookieDbPath: typeof defaultPendingImport === 'string' ? defaultPendingImport : null,
    enabledExtensionIdsByProfileId,
    pinnedExtensionIdsByProfileId
  }
}
