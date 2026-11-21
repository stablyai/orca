import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeBrowserSiteListEntry } from '../../../../shared/browser/profiles/browser-profile-site-list'
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
  allowedHostsByProfileId: Record<string, string[]>
}

export const BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'

// Shared by the extension id lists and the site lists: both are profile id -> string[].
function parseIdListsByProfileId(value: unknown): Record<string, string[]> {
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

function parseAllowedHosts(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [profileId, entries] of Object.entries(parseIdListsByProfileId(value))) {
    const valid = new Set<string>()
    for (const entry of entries) {
      const normalized = normalizeBrowserSiteListEntry(entry)
      if (normalized !== null) {
        valid.add(normalized)
      }
    }
    if (valid.size > 0) {
      result[profileId] = [...valid]
    }
  }
  return result
}

/** Enabled extensions per metadata file as last read; every write goes through persistBrowserSessionMeta. */
const enabledExtensionIdsByPath = new Map<
  string,
  BrowserSessionMeta['enabledExtensionIdsByProfileId']
>()

function copyIdLists(byProfileId: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(byProfileId).map(([id, ids]) => [id, [...ids]]))
}

function emptyBrowserSessionMeta(): BrowserSessionMeta {
  return {
    defaultSource: null,
    pendingCookieDbPath: null,
    pendingCookieImports: {},
    profiles: [],
    enabledExtensionIdsByProfileId: {},
    pinnedExtensionIdsByProfileId: {},
    allowedHostsByProfileId: {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

// Same looseness as before this check existed: any stored object counts as a source.
function isProfileSource(value: unknown): value is NonNullable<BrowserSessionProfile['source']> {
  return isRecord(value)
}

function parseBrowserSessionMeta(data: unknown, defaultPartition: string): BrowserSessionMeta {
  const record: Record<string, unknown> = isRecord(data) ? data : {}
  const legacyPendingCookieDbPath =
    typeof record.pendingCookieDbPath === 'string' ? record.pendingCookieDbPath : null
  const pendingCookieImports: Record<string, PendingBrowserCookieImport> = {}
  const rawImports = record.pendingCookieImports
  if (rawImports && typeof rawImports === 'object') {
    for (const [partition, entry] of Object.entries(rawImports)) {
      if (
        typeof entry === 'string' ||
        (entry &&
          typeof entry === 'object' &&
          'format' in entry &&
          typeof entry.format === 'string' &&
          'path' in entry &&
          typeof entry.path === 'string')
      ) {
        pendingCookieImports[partition] = entry
      }
    }
  }
  if (legacyPendingCookieDbPath && !pendingCookieImports[defaultPartition]) {
    pendingCookieImports[defaultPartition] = legacyPendingCookieDbPath
  }
  return {
    defaultSource: isProfileSource(record.defaultSource) ? record.defaultSource : null,
    pendingCookieDbPath: legacyPendingCookieDbPath,
    pendingCookieImports,
    profiles: Array.isArray(record.profiles) ? record.profiles : [],
    enabledExtensionIdsByProfileId: parseIdListsByProfileId(record.enabledExtensionIdsByProfileId),
    pinnedExtensionIdsByProfileId: parseIdListsByProfileId(record.pinnedExtensionIdsByProfileId),
    allowedHostsByProfileId: parseAllowedHosts(record.allowedHostsByProfileId)
  }
}

// Paths whose last read failed for a reason other than a missing file or invalid JSON.
const unreadableMetaPaths = new Set<string>()

// Resolve the path inside the load error boundary.
export function loadBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string
): BrowserSessionMeta {
  let path: string | undefined
  try {
    path = resolveMetadataPath()
    const meta = parseBrowserSessionMeta(JSON.parse(readFileSync(path, 'utf-8')), defaultPartition)
    unreadableMetaPaths.delete(path)
    // Only a read that worked is kept: a brief lock must not read as "nothing enabled" for the run.
    enabledExtensionIdsByPath.set(path, copyIdLists(meta.enabledExtensionIdsByProfileId))
    return meta
  } catch (error) {
    // A file that reads but isn't JSON may be overwritten as it always was; one we couldn't read may not.
    if (path !== undefined && !isMissingFileError(error) && !(error instanceof SyntaxError)) {
      unreadableMetaPaths.add(path)
    } else if (path !== undefined) {
      unreadableMetaPaths.delete(path)
    }
    return emptyBrowserSessionMeta()
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Null when the file exists but is unreadable; a missing file reads as empty. */
export async function readBrowserSessionMetaAsync(
  path: string,
  defaultPartition: string
): Promise<BrowserSessionMeta | null> {
  try {
    return parseBrowserSessionMeta(JSON.parse(await readFile(path, 'utf-8')), defaultPartition)
  } catch (error) {
    return isMissingFileError(error) ? emptyBrowserSessionMeta() : null
  }
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

const warnedUnreadablePaths = new Set<string>()

// Write to a temporary file so an interrupted write leaves the existing metadata intact.
export function persistBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string,
  updates: Partial<BrowserSessionMeta>
): void {
  try {
    const path = resolveMetadataPath()
    const existing = loadBrowserSessionMeta(() => path, defaultPartition)
    // An unreadable file may hold saved site lists, so it is never replaced blind.
    if (unreadableMetaPaths.has(path)) {
      if (!warnedUnreadablePaths.has(path)) {
        warnedUnreadablePaths.add(path)
        console.warn('[browser] session metadata is unreadable; not saving over it')
      }
      return
    }
    const tmpPath = `${path}.tmp`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify({ ...existing, ...updates }))
    renameSync(tmpPath, path)
    // The cache may hold contents this write replaced.
    enabledExtensionIdsByPath.delete(path)
  } catch {}
}

const MAX_ASYNC_WRITE_ATTEMPTS = 3

/**
 * Off-main-thread read-modify-write of the metadata file. False when the file is unreadable (it is
 * never rewritten then) or the write fails. Why the re-read before the rename: the registry's own
 * persistBrowserSessionMeta is synchronous and could land between our read and our rename; if the
 * file changed meanwhile we start over from it instead of replacing its update.
 */
export async function updateBrowserSessionMetaAsync(
  path: string,
  defaultPartition: string,
  update: (meta: BrowserSessionMeta) => Partial<BrowserSessionMeta>
): Promise<boolean> {
  const tmpPath = `${path}.site-list.tmp`
  try {
    for (let attempt = 0; attempt < MAX_ASYNC_WRITE_ATTEMPTS; attempt++) {
      const raw = await readBrowserSessionMetaText(path)
      if (raw === undefined) {
        return false
      }
      const existing =
        raw === null
          ? emptyBrowserSessionMeta()
          : parseBrowserSessionMeta(JSON.parse(raw), defaultPartition)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(tmpPath, JSON.stringify({ ...existing, ...update(existing) }))
      if ((await readBrowserSessionMetaText(path)) !== raw) {
        continue
      }
      await rename(tmpPath, path)
      enabledExtensionIdsByPath.delete(path)
      return true
    }
  } catch {
    // Fall through: the caller reports a failed save and keeps the old list.
  }
  // Reached after a failure or exhausted retries; a successful rename returned above.
  await rm(tmpPath, { force: true }).catch(() => {})
  return false
}

/** Null when the file is missing, undefined when it exists but cannot be read. */
async function readBrowserSessionMetaText(path: string): Promise<string | null | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    return isMissingFileError(error) ? null : undefined
  }
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
  const allowedHostsByProfileId = { ...meta.allowedHostsByProfileId }
  delete allowedHostsByProfileId[profile.id]
  return {
    pendingCookieImports,
    pendingCookieDbPath: typeof defaultPendingImport === 'string' ? defaultPendingImport : null,
    enabledExtensionIdsByProfileId,
    pinnedExtensionIdsByProfileId,
    allowedHostsByProfileId
  }
}
