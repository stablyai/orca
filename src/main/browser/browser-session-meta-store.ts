import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'

// Why: no userAgent fields — the session UA is always derived from the running
// engine at startup (clean or native), never persisted. Imports before Aug 2026
// stored a synthesized source-browser UA here; persistMeta drops those legacy
// keys on the next write because this loader no longer carries them.
export type BrowserSessionMeta = {
  defaultSource: BrowserSessionProfile['source']
  pendingCookieDbPath: string | null
  pendingCookieImports: Record<string, string>
  profiles: BrowserSessionProfile[]
}

export const BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'

// Why: the path is resolved lazily (app.getPath('userData') throws pre-ready) so the failure lands inside the existing swallow.
export function loadBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string
): BrowserSessionMeta {
  try {
    const raw = readFileSync(resolveMetadataPath(), 'utf-8')
    const data = JSON.parse(raw)
    const legacyPendingCookieDbPath =
      typeof data?.pendingCookieDbPath === 'string' ? data.pendingCookieDbPath : null
    const pendingCookieImports: Record<string, string> =
      data && typeof data.pendingCookieImports === 'object' && data.pendingCookieImports
        ? { ...data.pendingCookieImports }
        : {}
    if (legacyPendingCookieDbPath && !pendingCookieImports[defaultPartition]) {
      pendingCookieImports[defaultPartition] = legacyPendingCookieDbPath
    }
    return {
      defaultSource: data?.defaultSource ?? null,
      pendingCookieDbPath: legacyPendingCookieDbPath,
      pendingCookieImports,
      profiles: Array.isArray(data?.profiles) ? data.profiles : []
    }
  } catch {
    return {
      defaultSource: null,
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: []
    }
  }
}

// Why: write-temp-then-rename is atomic, so a crash mid-write can't corrupt the live file.
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
  } catch {
    // best-effort
  }
}
