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
import type { GlpiServer, GlpiServerSelection } from '../../shared/types'

// GLPI auth needs two secrets (an application token and a per-user API token),
// so each server stores them together as one encrypted JSON blob keyed by the
// server id. Mirrors the Jira per-site token-file model.
export type GlpiCredentials = { appToken: string; userToken: string }

type GlpiServerFile = {
  version: 1
  activeServerId: string | null
  selectedServerId: GlpiServerSelection | null
  servers: GlpiServer[]
}

let cachedFile: GlpiServerFile | null = null
let fileLoaded = false
const cachedCredentials = new Map<string, GlpiCredentials>()
// Why: decrypt failures are recorded per server so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getServerFilePath(): string {
  return join(getOrcaDir(), 'glpi-servers.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'glpi-tokens')
}

function getTokenPath(serverId: string): string {
  return join(getTokenDir(), `${Buffer.from(serverId).toString('base64url')}.enc`)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyFile(): GlpiServerFile {
  return { version: 1, activeServerId: null, selectedServerId: null, servers: [] }
}

export function hasStoredCredentials(serverId: string): boolean {
  return cachedCredentials.has(serverId) || credentialFileHasContent(getTokenPath(serverId))
}

// Normalizes the user-entered web URL to a bare origin+path without trailing
// slash or any /apirest.php suffix the user may have pasted.
export function normalizeGlpiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/apirest\.php$/i, '')
  return url.toString().replace(/\/$/, '')
}

export function glpiApiBaseFromWeb(baseUrl: string): string {
  return `${baseUrl}/apirest.php`
}

export function getServerId(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('base64url').slice(0, 24)
}

function normalizeServer(input: unknown): GlpiServer | null {
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

function readFromDisk(): GlpiServerFile {
  const path = getServerFilePath()
  if (!existsSync(path)) {
    return emptyFile()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<GlpiServerFile>
    const servers = Array.isArray(parsed.servers)
      ? parsed.servers
          .map((server) => normalizeServer(server))
          .filter((server): server is GlpiServer => server !== null)
          .filter((server) => hasStoredCredentials(server.id))
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
    return emptyFile()
  }
}

export function getServerFile(): GlpiServerFile {
  if (!fileLoaded || !cachedFile) {
    cachedFile = readFromDisk()
    fileLoaded = true
  }
  return cachedFile
}

export function writeServerFile(file: GlpiServerFile): void {
  ensureDir(getOrcaDir())
  const servers = file.servers.filter((server) => hasStoredCredentials(server.id))
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
  cachedFile = { version: 1, activeServerId, selectedServerId, servers }
  fileLoaded = true
  writeFileSync(getServerFilePath(), JSON.stringify(cachedFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

export function readCredentials(serverId: string): GlpiCredentials | null {
  const cached = cachedCredentials.get(serverId)
  if (cached !== undefined) {
    return cached
  }
  const path = getTokenPath(serverId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = readStoredCredentialToken('GLPI', readFileSync(path))
    credentialErrors.delete(serverId)
    if (!token) {
      return null
    }
    const parsed = JSON.parse(token) as Partial<GlpiCredentials>
    if (typeof parsed.appToken !== 'string' || typeof parsed.userToken !== 'string') {
      return null
    }
    const credentials = { appToken: parsed.appToken, userToken: parsed.userToken }
    cachedCredentials.set(serverId, credentials)
    return credentials
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(serverId, error.message)
      throw error
    }
    return null
  }
}

export function saveCredentials(serverId: string, credentials: GlpiCredentials): void {
  ensureDir(getOrcaDir())
  ensureDir(getTokenDir())
  const blob = JSON.stringify(credentials)
  const path = getTokenPath(serverId)
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(blob), { mode: 0o600 })
  } else {
    console.warn('[glpi] safeStorage encryption unavailable — storing tokens in plaintext')
    writeFileSync(path, blob, { encoding: 'utf-8', mode: 0o600 })
  }
  cachedCredentials.set(serverId, credentials)
  credentialErrors.delete(serverId)
}

export function deleteCredentials(serverId: string): void {
  cachedCredentials.delete(serverId)
  credentialErrors.delete(serverId)
  try {
    unlinkSync(getTokenPath(serverId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}

export function getCredentialError(serverId: string): string | undefined {
  return credentialErrors.get(serverId)
}

// Resolves the servers a selection covers: a single stored server, or every
// server when the selection is 'all'.
export function getSelectedServers(selection?: GlpiServerSelection | null): GlpiServer[] {
  const file = getServerFile()
  const selected = selection ?? file.selectedServerId ?? file.activeServerId
  if (selected === 'all') {
    return file.servers
  }
  const target = selected ?? file.activeServerId
  return file.servers.filter((server) => server.id === target)
}
