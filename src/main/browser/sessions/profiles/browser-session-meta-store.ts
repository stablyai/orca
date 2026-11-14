import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'

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

/** Extension reads share the registry's current metadata; cookie staging still merges from disk. */
export class BrowserSessionExtensionLists {
  private lists?: Pick<
    BrowserSessionMeta,
    'enabledExtensionIdsByProfileId' | 'pinnedExtensionIdsByProfileId'
  >

  constructor(private readonly load: () => BrowserSessionMeta) {}

  remember(meta: BrowserSessionMeta): void {
    this.lists = {
      enabledExtensionIdsByProfileId: meta.enabledExtensionIdsByProfileId,
      pinnedExtensionIdsByProfileId: meta.pinnedExtensionIdsByProfileId
    }
  }

  persist(
    resolvePath: () => string,
    partition: string,
    updates: Partial<BrowserSessionMeta>
  ): void {
    const written = persistBrowserSessionMeta(resolvePath, partition, updates)
    if (written) {
      this.remember(written)
    }
  }

  forget(): void {
    this.lists = undefined
  }

  read(
    key: 'enabledExtensionIdsByProfileId' | 'pinnedExtensionIdsByProfileId',
    profileId: string
  ): string[] {
    if (!this.lists) {
      this.remember(this.load())
    }
    return [...(this.lists![key][profileId] ?? [])]
  }
}

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

// Resolve the path inside the load error boundary.
export function loadBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string
): BrowserSessionMeta {
  try {
    const raw = readFileSync(resolveMetadataPath(), 'utf-8')
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
    return {
      defaultSource: data?.defaultSource ?? null,
      pendingCookieDbPath: legacyPendingCookieDbPath,
      pendingCookieImports,
      profiles: Array.isArray(data?.profiles) ? data.profiles : [],
      enabledExtensionIdsByProfileId: parseEnabledExtensionIds(
        data?.enabledExtensionIdsByProfileId
      ),
      pinnedExtensionIdsByProfileId: parseEnabledExtensionIds(data?.pinnedExtensionIdsByProfileId)
    }
  } catch {
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

// Write to a temporary file so an interrupted write leaves the existing metadata intact.
export function persistBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string,
  updates: Partial<BrowserSessionMeta>
): BrowserSessionMeta | null {
  try {
    const existing = loadBrowserSessionMeta(resolveMetadataPath, defaultPartition)
    const next = { ...existing, ...updates }
    const tmpPath = `${resolveMetadataPath()}.tmp`
    mkdirSync(dirname(resolveMetadataPath()), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(next))
    renameSync(tmpPath, resolveMetadataPath())
    return next
  } catch {
    return null
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
  return {
    pendingCookieImports,
    pendingCookieDbPath: typeof defaultPendingImport === 'string' ? defaultPendingImport : null,
    enabledExtensionIdsByProfileId,
    pinnedExtensionIdsByProfileId
  }
}
