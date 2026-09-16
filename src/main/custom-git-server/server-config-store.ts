import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CUSTOM_GIT_SERVER_API_FLAVOR,
  isCustomGitServerApiFlavor,
  matchCustomGitServerForHost,
  normalizeCustomGitServerApiBaseUrl,
  normalizeCustomGitServerHost,
  type CustomGitServer,
  type CustomGitServerApiFlavor,
  type CustomGitServerDraft
} from '../../shared/custom-git-server'

// Why: this module is deliberately electron-free (no safeStorage). Repo/provider
// detection needs only the server list + host match, so keeping tokens out of
// this path lets forge-provider detection load without pulling `electron` into
// unrelated test graphs. Token I/O lives in token-store.ts.

type CustomGitServerFile = {
  version: 1
  servers: CustomGitServer[]
}

let cachedFile: CustomGitServerFile | null = null
let fileLoaded = false

/** @internal - exposed for tests only */
export function _resetCustomGitServerStoreCache(): void {
  cachedFile = null
  fileLoaded = false
}

/** Orca's per-user config directory (~/.orca), where server config and tokens live. */
export function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getServerFilePath(): string {
  return join(getOrcaDir(), 'custom-git-servers.json')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyFile(): CustomGitServerFile {
  return { version: 1, servers: [] }
}

function normalizeServerRecord(input: unknown): CustomGitServer | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.host !== 'string' ||
    typeof record.apiBaseUrl !== 'string'
  ) {
    return null
  }
  const apiFlavor: CustomGitServerApiFlavor = isCustomGitServerApiFlavor(record.apiFlavor)
    ? record.apiFlavor
    : DEFAULT_CUSTOM_GIT_SERVER_API_FLAVOR
  return {
    id: record.id,
    name: record.name,
    host: record.host,
    apiBaseUrl: record.apiBaseUrl,
    apiFlavor
  }
}

function readFileFromDisk(): CustomGitServerFile {
  const path = getServerFilePath()
  if (!existsSync(path)) {
    return emptyFile()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<
      CustomGitServerFile
    >
    const servers = Array.isArray(parsed.servers)
      ? parsed.servers
          .map((server) => normalizeServerRecord(server))
          .filter((server): server is CustomGitServer => server !== null)
      : []
    return { version: 1, servers }
  } catch {
    return emptyFile()
  }
}

function getFile(): CustomGitServerFile {
  if (!fileLoaded || !cachedFile) {
    cachedFile = readFileFromDisk()
    fileLoaded = true
  }
  return cachedFile
}

/** Persist the full server list to disk (0600) and refresh the cache. */
export function writeCustomGitServerConfig(servers: CustomGitServer[]): void {
  ensureOrcaDir()
  const nextFile: CustomGitServerFile = { version: 1, servers }
  writeFileSync(getServerFilePath(), JSON.stringify(nextFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
  // Why: adopt the new state into the cache only after the write succeeds, so a
  // failed write leaves the cache consistent with what's actually on disk.
  cachedFile = nextFile
  fileLoaded = true
}

/**
 * Deterministic id from host+apiBaseUrl so re-adding the same server is
 * idempotent (same id → in-place replace, one token file).
 */
export function computeCustomGitServerId(host: string, apiBaseUrl: string): string {
  return createHash('sha256').update(`${host}\n${apiBaseUrl}`).digest('base64url').slice(0, 24)
}

/** Trim/normalize a UI draft's fields into a storable server shape. */
export function normalizeCustomGitServerDraft(
  draft: CustomGitServerDraft
): Pick<CustomGitServer, 'name' | 'host' | 'apiBaseUrl' | 'apiFlavor'> {
  return {
    name: draft.name.trim(),
    host: normalizeCustomGitServerHost(draft.host),
    apiBaseUrl: normalizeCustomGitServerApiBaseUrl(draft.apiBaseUrl),
    apiFlavor: isCustomGitServerApiFlavor(draft.apiFlavor)
      ? draft.apiFlavor
      : DEFAULT_CUSTOM_GIT_SERVER_API_FLAVOR
  }
}

/** All configured servers (a copy, safe to mutate). */
export function listCustomGitServers(): CustomGitServer[] {
  return [...getFile().servers]
}

/** Look up a configured server by id, or null if none. */
export function getCustomGitServerById(id: string): CustomGitServer | null {
  return getFile().servers.find((server) => server.id === id) ?? null
}

/** Resolve the configured server (if any) that owns `remoteHost`. */
export function getCustomGitServerForHost(remoteHost: string): CustomGitServer | null {
  return matchCustomGitServerForHost(remoteHost, getFile().servers)
}
