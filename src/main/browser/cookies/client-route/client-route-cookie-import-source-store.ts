import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserSessionProfileSource } from '../../../../shared/browser/workspaces/browser-workspace-types'

/** Keep import badges on this desktop because its route jars are absent from server profile records. */
const FILE_NAME = 'client-route-cookie-import-sources.json'
const MAX_ENTRIES = 128

type StoredSources = Record<string, BrowserSessionProfileSource>

let loaded: Promise<StoredSources> | null = null
// Why: each change reads the previous one's result, so overlapping import and clear can't drop a write.
let changes: Promise<unknown> = Promise.resolve()

function storePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function entryKey(environmentId: string, profileId: string): string {
  return `${environmentId}\u0000${profileId}`
}

function parseSources(raw: string): StoredSources {
  const parsed: unknown = JSON.parse(raw)
  const sources: StoredSources = {}
  if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as { browserFamily?: unknown }).browserFamily === 'string'
      ) {
        sources[key] = value as BrowserSessionProfileSource
      }
    }
  }
  return sources
}

function load(): Promise<StoredSources> {
  loaded ??= readFile(storePath(), 'utf-8').then(parseSources, () => ({}))
  return loaded
}

function change(apply: (sources: StoredSources) => StoredSources | null): Promise<void> {
  const run = changes.then(async () => {
    const next = apply(await load())
    if (!next) {
      return
    }
    loaded = Promise.resolve(next)
    try {
      const path = storePath()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(next))
    } catch {
      // A display-only badge must not make cookie import or clear fail.
    }
  })
  changes = run.catch(() => {})
  return run
}

export function recordClientRouteCookieImportSource(args: {
  environmentId: string
  profileId: string
  source: BrowserSessionProfileSource
}): Promise<void> {
  return change((sources) => {
    const next: StoredSources = {
      ...sources,
      [entryKey(args.environmentId, args.profileId)]: args.source
    }
    const keys = Object.keys(next)
    if (keys.length > MAX_ENTRIES) {
      const byAge = keys.sort((a, b) => (next[a]?.importedAt ?? 0) - (next[b]?.importedAt ?? 0))
      for (const key of byAge.slice(0, keys.length - MAX_ENTRIES)) {
        delete next[key]
      }
    }
    return next
  })
}

export function forgetClientRouteCookieImportSource(args: {
  environmentId: string
  profileId: string
}): Promise<void> {
  const key = entryKey(args.environmentId, args.profileId)
  return change((sources) => {
    if (!(key in sources)) {
      return null
    }
    const next = { ...sources }
    delete next[key]
    return next
  })
}

export async function clientRouteCookieImportSources(
  environmentId: string
): Promise<Record<string, BrowserSessionProfileSource>> {
  const prefix = `${environmentId}\u0000`
  const result: Record<string, BrowserSessionProfileSource> = {}
  for (const [key, source] of Object.entries(await load())) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = source
    }
  }
  return result
}
