import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrowserSessionProfileSource } from '../../shared/browser-workspace-types'

/**
 * Which desktop browser a client-hosted route partition's cookies came from,
 * keyed per (environment × session profile). The server's profile records
 * cannot carry this — the import never touches the server, and each desktop
 * holds its own jar — so the client persists it and the settings view overlays
 * it onto the server's profile list.
 */
const FILE_NAME = 'client-route-cookie-import-sources.json'
// Why: one entry per (paired server × profile) the user imported into — a cap this
// generous only guards against pathological growth, evicting oldest imports first.
const MAX_ENTRIES = 128

type StoredSources = Record<string, BrowserSessionProfileSource>

let cached: StoredSources | null = null

function storePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function entryKey(environmentId: string, profileId: string): string {
  return `${environmentId}\u0000${profileId}`
}

function load(): StoredSources {
  if (cached) {
    return cached
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), 'utf-8'))
    cached = {}
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        if (
          value &&
          typeof value === 'object' &&
          typeof (value as { browserFamily?: unknown }).browserFamily === 'string'
        ) {
          cached[key] = value as BrowserSessionProfileSource
        }
      }
    }
  } catch {
    cached = {}
  }
  return cached
}

function persist(sources: StoredSources): void {
  cached = sources
  try {
    const path = storePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(sources))
  } catch {
    // Why: the badge is display-only — never let its persistence fail an import.
  }
}

export function recordClientRouteCookieImportSource(args: {
  environmentId: string
  profileId: string
  source: BrowserSessionProfileSource
}): void {
  const next: StoredSources = {
    ...load(),
    [entryKey(args.environmentId, args.profileId)]: args.source
  }
  const keys = Object.keys(next)
  if (keys.length > MAX_ENTRIES) {
    const byAge = keys.sort((a, b) => (next[a]?.importedAt ?? 0) - (next[b]?.importedAt ?? 0))
    for (const key of byAge.slice(0, keys.length - MAX_ENTRIES)) {
      delete next[key]
    }
  }
  persist(next)
}

/** Sources for one environment's profiles, keyed by profile id. */
export function clientRouteCookieImportSources(
  environmentId: string
): Record<string, BrowserSessionProfileSource> {
  const prefix = `${environmentId}\u0000`
  const result: Record<string, BrowserSessionProfileSource> = {}
  for (const [key, source] of Object.entries(load())) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = source
    }
  }
  return result
}

export function resetClientRouteCookieImportSourcesForTests(): void {
  cached = null
}
