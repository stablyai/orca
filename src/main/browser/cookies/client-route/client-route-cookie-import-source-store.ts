import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserSessionProfileSource } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { ClientHostRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'

/** Keep import badges on this desktop because its route jars are absent from server profile records. */
const FILE_NAME = 'client-route-cookie-import-sources.json'
const MAX_ENTRIES = 128

type StoredSources = Record<string, BrowserSessionProfileSource>

let cached: Promise<StoredSources> | undefined

function storePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

async function readSources(): Promise<StoredSources> {
  const sources: StoredSources = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(), 'utf-8'))
    // Older flat records lack an Orca profile, so no route can claim them.
    const scoped =
      parsed && typeof parsed === 'object' && 'scopedSources' in parsed
        ? parsed.scopedSources
        : null
    if (scoped && typeof scoped === 'object') {
      for (const [key, value] of Object.entries(scoped)) {
        if (
          value &&
          typeof value === 'object' &&
          typeof (value as { browserFamily?: unknown }).browserFamily === 'string'
        ) {
          sources[key] = value as BrowserSessionProfileSource
        }
      }
    }
  } catch {
    // Older installs can have no source records.
  }
  return sources
}

function persist(sources: StoredSources): void {
  try {
    const path = storePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ scopedSources: sources }))
  } catch {
    // Keep the import usable in memory if its source cannot be saved.
  }
}

export async function openClientRouteCookieImportSources(
  route: Pick<ClientHostRouteIdentity, 'storageScope' | 'authorityConnectionIdentity'>
) {
  const stored = await (cached ??= readSources())
  const prefix = `${JSON.stringify([route.storageScope, route.authorityConnectionIdentity])}\u0000`
  const sources: StoredSources = {}
  for (const [key, source] of Object.entries(stored)) {
    if (key.startsWith(prefix)) {
      sources[key.slice(prefix.length)] = source
    }
  }

  function record(profileId: string, source: BrowserSessionProfileSource): void {
    stored[prefix + profileId] = source
    const keys = Object.keys(stored)
    if (keys.length > MAX_ENTRIES) {
      const byAge = keys.sort((a, b) => (stored[a]?.importedAt ?? 0) - (stored[b]?.importedAt ?? 0))
      for (const key of byAge.slice(0, keys.length - MAX_ENTRIES)) {
        delete stored[key]
      }
    }
    persist(stored)
  }

  return { sources, record }
}
