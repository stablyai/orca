import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserSessionProfileSource } from '../../../../shared/browser/workspaces/browser-workspace-types'

/** Keep import badges on this desktop because its route jars are absent from server profile records. */
const FILE_NAME = 'client-route-cookie-import-sources.json'
const MAX_ENTRIES = 128

type StoredSources = Record<string, BrowserSessionProfileSource & { authority?: string }>

let cached: Promise<StoredSources> | undefined

function storePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function entryKey(environmentId: string, profileId: string): string {
  return `${environmentId}\u0000${profileId}`
}

async function readSources(): Promise<StoredSources> {
  const sources: StoredSources = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(), 'utf-8'))
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
  } catch {
    // Older installs can have no source records.
  }
  return sources
}

function persist(sources: StoredSources): void {
  try {
    const path = storePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(sources))
  } catch {
    // A display-only badge must not make cookie import fail.
  }
}

export async function openClientRouteCookieImportSources(environmentId: string, authority: string) {
  const stored = await (cached ??= readSources())
  const prefix = `${environmentId}\u0000`
  const sources: Record<string, BrowserSessionProfileSource> = {}
  for (const [key, { authority: recordedAuthority, ...source }] of Object.entries(stored)) {
    if (key.startsWith(prefix) && (!recordedAuthority || recordedAuthority === authority)) {
      sources[key.slice(prefix.length)] = recordedAuthority
        ? source
        : { ...source, chromeProfile: undefined }
    }
  }

  function record(profileId: string, source: BrowserSessionProfileSource): void {
    stored[entryKey(environmentId, profileId)] = { ...source, authority }
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
