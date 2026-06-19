import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { safeStorage } from 'electron'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import type { GiteaServer, GiteaServerSelection } from '../../shared/gitea-types'

// Persistent multi-server credential store for Gitea, mirroring the Jira
// multi-site model: server metadata in a JSON file, tokens encrypted per
// server via safeStorage. Gitea issues are repo-scoped, so reads resolve a
// stored server by the repo remote host (getServerForHost).

export type GiteaServerFile = {
  version: 1
  activeServerId: string | null
  selectedServerId: GiteaServerSelection | null
  servers: GiteaServer[]
}

export type GiteaServerToken = {
  server: GiteaServer
  token: string
}

let cachedServerFile: GiteaServerFile | null = null
let serverFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per server so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

// Derives the web base URL (no /api/v1 suffix) shown to users from an API base.
export function deriveGiteaWebBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/api\/v1$/i, '')
}

export function giteaServerHost(server: Pick<GiteaServer, 'apiBaseUrl'>): string | null {
  try {
    return new URL(server.apiBaseUrl).host.toLowerCase()
  } catch {
    return null
  }
}

export function getGiteaServerId(apiBaseUrl: string): string {
  return createHash('sha256').update(apiBaseUrl).digest('base64url').slice(0, 24)
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getServerFilePath(): string {
  return join(getOrcaDir(), 'gitea-servers.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'gitea-tokens')
}

function getTokenPath(serverId: string): string {
  return join(getTokenDir(), `${Buffer.from(serverId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureTokenDir(): void {
  const dir = getTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyServerFile(): GiteaServerFile {
  return {
    version: 1,
    activeServerId: null,
    selectedServerId: null,
    servers: []
  }
}

export function hasStoredToken(serverId: string): boolean {
  return cachedTokens.has(serverId) || credentialFileHasContent(getTokenPath(serverId))
}

function normalizeServer(input: unknown): GiteaServer | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.baseUrl !== 'string' ||
    typeof record.apiBaseUrl !== 'string' ||
    typeof record.displayName !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    baseUrl: record.baseUrl,
    apiBaseUrl: record.apiBaseUrl,
    displayName: record.displayName,
    account: typeof record.account === 'string' ? record.account : null
  }
}

function readServerFileFromDisk(): GiteaServerFile {
  const path = getServerFilePath()
  if (!existsSync(path)) {
    return emptyServerFile()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<GiteaServerFile>
    const servers = Array.isArray(parsed.servers)
      ? parsed.servers
          .map((server) => normalizeServer(server))
          .filter((server): server is GiteaServer => server !== null)
          .filter((server) => hasStoredToken(server.id))
      : []
    const activeServerId =
      typeof parsed.activeServerId === 'string' &&
      servers.some((server) => server.id === parsed.activeServerId)
        ? parsed.activeServerId
        : (servers[0]?.id ?? null)
    const selectedServerId =
      parsed.selectedServerId === 'all' ||
      (typeof parsed.selectedServerId === 'string' &&
        servers.some((server) => server.id === parsed.selectedServerId))
        ? parsed.selectedServerId
        : activeServerId
    return { version: 1, activeServerId, selectedServerId, servers }
  } catch {
    return emptyServerFile()
  }
}

export function getServerFile(): GiteaServerFile {
  if (!serverFileLoaded || !cachedServerFile) {
    cachedServerFile = readServerFileFromDisk()
    serverFileLoaded = true
  }
  return cachedServerFile
}

export function writeServerFile(file: GiteaServerFile): void {
  ensureOrcaDir()
  const servers = file.servers.filter((server) => hasStoredToken(server.id))
  const activeServerId =
    file.activeServerId && servers.some((server) => server.id === file.activeServerId)
      ? file.activeServerId
      : (servers[0]?.id ?? null)
  const selectedServerId =
    file.selectedServerId === 'all'
      ? 'all'
      : file.selectedServerId && servers.some((server) => server.id === file.selectedServerId)
        ? file.selectedServerId
        : activeServerId

  cachedServerFile = {
    version: 1,
    activeServerId,
    selectedServerId,
    servers
  }
  serverFileLoaded = true
  writeFileSync(getServerFilePath(), JSON.stringify(cachedServerFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function writeEncryptedToken(path: string, token: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 })
    return
  }
  console.warn('[gitea] safeStorage encryption unavailable — storing token in plaintext')
  writeFileSync(path, token, { encoding: 'utf-8', mode: 0o600 })
}

export function readToken(serverId: string): string | null {
  const cached = cachedTokens.get(serverId)
  if (cached !== undefined) {
    return cached
  }
  const path = getTokenPath(serverId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path)
    const token = readStoredCredentialToken('Gitea', raw)
    if (token) {
      cachedTokens.set(serverId, token)
    }
    credentialErrors.delete(serverId)
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(serverId, error.message)
      throw error
    }
    return null
  }
}

export function saveToken(serverId: string, token: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  writeEncryptedToken(getTokenPath(serverId), token)
  cachedTokens.set(serverId, token)
  credentialErrors.delete(serverId)
}

export function deleteToken(serverId: string): void {
  cachedTokens.delete(serverId)
  credentialErrors.delete(serverId)
  try {
    unlinkSync(getTokenPath(serverId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}

export function getCredentialError(serverIds: readonly string[]): string | undefined {
  return serverIds.map((id) => credentialErrors.get(id)).find((message) => message !== undefined)
}

// Returns the stored server + token for a repo remote host, or null when no
// connected server matches. Used to authenticate repo-scoped Gitea requests.
export function getServerForHost(host: string | null | undefined): GiteaServerToken | null {
  if (!host) {
    return null
  }
  const normalizedHost = host.toLowerCase()
  const file = getServerFile()
  const server = file.servers.find((entry) => giteaServerHost(entry) === normalizedHost)
  if (!server) {
    return null
  }
  let token: string | null
  try {
    token = readToken(server.id)
  } catch {
    // Decrypt failure was recorded per server; treat as no usable credential.
    return null
  }
  return token ? { server, token } : null
}

// Returns connected servers + tokens for a selection, mirroring Jira's
// getClients: an 'all' selection skips un-decryptable servers while a specific
// selection rethrows so the renderer can surface the decrypt banner.
export function getServerTokens(selection?: GiteaServerSelection | null): GiteaServerToken[] {
  const file = getServerFile()
  const selected = selection ?? file.selectedServerId ?? file.activeServerId
  const isAllSelection = selected === 'all'
  const servers = isAllSelection
    ? file.servers
    : file.servers.filter((server) => server.id === (selected ?? file.activeServerId))

  return servers.flatMap((server) => {
    let token: string | null
    try {
      token = readToken(server.id)
    } catch (error) {
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ server, token }] : []
  })
}

// Test-only: reset module caches so suites do not leak server/token state.
export function _resetGiteaServerStoreForTest(): void {
  cachedServerFile = null
  serverFileLoaded = false
  cachedTokens.clear()
  credentialErrors.clear()
}
