import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserSessionProfileSource } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { ClientHostRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'

/** Keep import badges on this desktop because its route jars are absent from server profile records. */
const FILE_NAME = 'client-route-cookie-import-sources.json'
const MAX_ENTRIES = 128

type StoredSources = Record<string, BrowserSessionProfileSource>
type SourceRoute = Pick<ClientHostRouteIdentity, 'storageScope' | 'authorityConnectionIdentity'>

let loaded: Promise<StoredSources> | null = null
// Why: each change reads the previous one's result, so overlapping import and clear can't drop a write.
let changes: Promise<unknown> = Promise.resolve()

function storePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function routePrefix(route: SourceRoute): string {
  return `${JSON.stringify([route.storageScope, route.authorityConnectionIdentity])}\u0000`
}

function parseSources(raw: string): StoredSources {
  const parsed: unknown = JSON.parse(raw)
  const sources: StoredSources = {}
  // Older flat records lack an Orca profile, so no route can claim them.
  if (
    parsed &&
    typeof parsed === 'object' &&
    'scopedSources' in parsed &&
    parsed.scopedSources &&
    typeof parsed.scopedSources === 'object'
  ) {
    for (const [key, value] of Object.entries(parsed.scopedSources)) {
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
  // A missing or corrupt file must never block cookie import or clear.
  loaded ??= readFile(storePath(), 'utf-8')
    .then(parseSources)
    .catch((): StoredSources => ({}))
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
      await writeFile(path, JSON.stringify({ scopedSources: next }))
    } catch {
      // A display-only badge must not make cookie import or clear fail.
    }
  })
  changes = run.catch(() => {})
  return run
}

export function forgetClientRouteCookieImportSource(
  route: SourceRoute,
  profileId: string
): Promise<void> {
  const key = routePrefix(route) + profileId
  return change((sources) => {
    if (!(key in sources)) {
      return null
    }
    const next = { ...sources }
    delete next[key]
    return next
  })
}

export async function openClientRouteCookieImportSources(route: SourceRoute) {
  const prefix = routePrefix(route)
  const sources: StoredSources = {}
  await changes
  for (const [key, source] of Object.entries(await load())) {
    if (key.startsWith(prefix)) {
      sources[key.slice(prefix.length)] = source
    }
  }

  function record(profileId: string, source: BrowserSessionProfileSource): Promise<void> {
    return change((stored) => {
      const next = { ...stored, [prefix + profileId]: source }
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

  return { sources, record }
}
