import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import type { BrowserSessionProfileSource } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { ClientHostRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'

/** Keep import badges on this desktop because its route jars are absent from server profile records. */
const FILE_NAME = 'client-route-cookie-import-sources.json'
type StoredSources = Record<string, BrowserSessionProfileSource | null>
type SourceFile = { scopedSources: StoredSources; legacySources: StoredSources }
type SourceRoute = Pick<ClientHostRouteIdentity, 'storageScope' | 'authorityConnectionIdentity'> & {
  environmentId: string
}

let loaded: Promise<SourceFile> | null = null
// Why: each change reads the previous one's result, so overlapping import and clear can't drop a write.
let changes: Promise<unknown> = Promise.resolve()

function storePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function routePrefix(route: SourceRoute): string {
  return `${JSON.stringify([route.storageScope, route.authorityConnectionIdentity])}\u0000`
}

export function sshCookieImportRoute(targetId: string): string {
  return `ssh:${targetId}`
}

function sourceEntries(value: unknown): StoredSources {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, source]) =>
        source === null || (typeof source === 'object' && typeof source.browserFamily === 'string')
    )
  )
}

function parseSources(raw: string): SourceFile {
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && 'scopedSources' in parsed) {
    return {
      scopedSources: sourceEntries(parsed.scopedSources),
      legacySources: sourceEntries('legacySources' in parsed ? parsed.legacySources : null)
    }
  }
  return { scopedSources: {}, legacySources: sourceEntries(parsed) }
}

function load(): Promise<SourceFile> {
  loaded ??= readFile(storePath(), 'utf-8')
    .then(parseSources)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return { scopedSources: {}, legacySources: {} }
      }
      loaded = null
      throw error
    })
  return loaded
}

function change(apply: (sources: SourceFile) => SourceFile | null): Promise<void> {
  const run = changes.then(async () => {
    const next = apply(await load())
    if (!next) {
      return
    }
    const path = storePath()
    await mkdir(dirname(path), { recursive: true })
    writeFileAtomically(path, JSON.stringify(next), { mode: 0o600 })
    loaded = Promise.resolve(next)
  })
  changes = run.catch(() => {})
  return run
}

export function recordClientRouteCookieImportSource(args: {
  route: string
  profileId: string
  source: BrowserSessionProfileSource
}): Promise<void> {
  const { browserFamily, profileName, importedAt } = args.source
  const key = `${args.route}\u0000${args.profileId}`
  return change((sources) => ({
    ...sources,
    legacySources: { ...sources.legacySources, [key]: { browserFamily, profileName, importedAt } }
  }))
}

export function forgetClientRouteCookieImportSource({
  route,
  profileId
}: {
  route: SourceRoute | string
  profileId: string
}): Promise<void> {
  if (typeof route === 'string') {
    const key = `${route}\u0000${profileId}`
    return change((sources) => {
      if (!(key in sources.legacySources)) {
        return null
      }
      const legacySources = { ...sources.legacySources }
      delete legacySources[key]
      return { ...sources, legacySources }
    })
  }
  const key = routePrefix(route) + profileId
  const legacyKey = `${route.environmentId}\u0000${profileId}`
  return change((sources) => {
    const hasLegacy = Boolean(sources.legacySources[legacyKey])
    if (!(key in sources.scopedSources) && !hasLegacy) {
      return null
    }
    const scopedSources = { ...sources.scopedSources }
    if (hasLegacy) {
      scopedSources[key] = null
    } else {
      delete scopedSources[key]
    }
    return { ...sources, scopedSources }
  })
}

function displaySources(route: string, stored: StoredSources) {
  const prefix = `${route}\u0000`
  const sources: Record<string, BrowserSessionProfileSource> = Object.create(null)
  for (const [key, source] of Object.entries(stored)) {
    if (source && key.startsWith(prefix)) {
      // Unscoped records supply a badge without refresh authority.
      const { browserFamily, profileName, importedAt } = source
      sources[key.slice(prefix.length)] = { browserFamily, profileName, importedAt }
    }
  }
  return sources
}

export async function clientRouteCookieImportSources(route: string) {
  await changes
  return displaySources(route, (await load()).legacySources)
}

export async function openClientRouteCookieImportSources(route: SourceRoute) {
  const prefix = routePrefix(route)
  await changes
  const { legacySources, scopedSources } = await load()
  const sources = displaySources(route.environmentId, legacySources)
  for (const [key, source] of Object.entries(scopedSources)) {
    if (key.startsWith(prefix)) {
      const profileId = key.slice(prefix.length)
      if (source) {
        sources[profileId] = source
      } else {
        delete sources[profileId]
      }
    }
  }

  function record(profileId: string, source: BrowserSessionProfileSource): Promise<void> {
    return change((stored) => ({
      ...stored,
      scopedSources: { ...stored.scopedSources, [prefix + profileId]: source }
    }))
  }

  return { sources, record }
}
