import { app } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

/** A JSON file of browser profile id → site → entry, kept in the Orca profile directory. */
export type BrowserProfileSiteStore<Entry> = {
  configure: (profileDirectory: string) => void
  get: (profileId: string, site: string) => Entry | undefined
  /** Null forgets the site. */
  set: (profileId: string, site: string, entry: Entry | null) => void
  list: (profileId: string) => [site: string, entry: Entry][]
  forget: (profileId: string) => void
}

type StoredSites<Entry> = Record<string, Record<string, Entry>>

export function createBrowserProfileSiteStore<Entry>({
  fileName,
  description,
  parseEntry
}: {
  fileName: string
  /** Names the file in the save-failure log. */
  description: string
  /** Null drops an unreadable or empty entry. */
  parseEntry: (value: unknown) => Entry | null
}): BrowserProfileSiteStore<Entry> {
  let filePathOverride: string | null = null
  let cached: { path: string; sites: StoredSites<Entry> } | null = null

  // Why lazy: app.getPath('userData') throws before ready.
  const storePath = (): string => filePathOverride ?? join(app.getPath('userData'), fileName)

  const parse = (raw: string): StoredSites<Entry> => {
    const parsed: unknown = JSON.parse(raw)
    const stored: StoredSites<Entry> = {}
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
      const parsedSites: Record<string, Entry> = {}
      for (const [site, value] of Object.entries(sites)) {
        const entry = parseEntry(value)
        if (entry !== null) {
          parsedSites[site] = entry
        }
      }
      stored[profileId] = parsedSites
    }
    return stored
  }

  const load = (): StoredSites<Entry> => {
    let path: string
    try {
      path = storePath()
    } catch {
      return {}
    }
    if (cached?.path === path) {
      return cached.sites
    }
    let sites: StoredSites<Entry> = {}
    try {
      sites = parse(readFileSync(path, 'utf-8'))
    } catch {
      // Missing or unreadable: every site starts over.
    }
    cached = { path, sites }
    return sites
  }

  const persist = (sites: StoredSites<Entry>): void => {
    try {
      const path = storePath()
      cached = { path, sites }
      mkdirSync(dirname(path), { recursive: true })
      writeFileDurableSync(
        durableWriteTempPath(path),
        path,
        `${JSON.stringify({ version: 1, profiles: sites }, null, 2)}\n`
      )
    } catch (error) {
      // Why: the change still holds for this run; failing the user's action would punish them.
      console.error(`[browser] Could not save ${description}:`, error)
    }
  }

  return {
    configure: (profileDirectory) => {
      filePathOverride = join(profileDirectory, fileName)
    },
    get: (profileId, site) => load()[profileId]?.[site],
    set: (profileId, site, entry) => {
      const stored = load()
      const sites = { ...stored[profileId] }
      if (entry === null) {
        delete sites[site]
      } else {
        sites[site] = entry
      }
      persist({ ...stored, [profileId]: sites })
    },
    list: (profileId) =>
      Object.entries(load()[profileId] ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    forget: (profileId) => {
      const stored = load()
      if (!(profileId in stored)) {
        return
      }
      const { [profileId]: _forgotten, ...rest } = stored
      persist(rest)
    }
  }
}
