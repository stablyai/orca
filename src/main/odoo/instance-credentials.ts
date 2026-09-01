import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import type {
  OdooConnectionStatus,
  OdooInstance,
  OdooInstanceSelection,
  OdooViewer
} from '../../shared/odoo-types'
type OdooInstanceFile = {
  version: 1
  activeInstanceId: string | null
  selectedInstanceId: OdooInstanceSelection | null
  instances: OdooInstance[]
}

let cachedInstanceFile: OdooInstanceFile | null = null
let instanceFileLoaded = false
const cachedKeys = new Map<string, string>()
// Why: decrypt failures are recorded per instance so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getInstanceFilePath(): string {
  return join(getOrcaDir(), 'odoo-instances.json')
}

function getKeyDir(): string {
  return join(getOrcaDir(), 'odoo-keys')
}

function getKeyPath(instanceId: string): string {
  return join(getKeyDir(), `${Buffer.from(instanceId).toString('base64url')}.enc`)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyInstanceFile(): OdooInstanceFile {
  return {
    version: 1,
    activeInstanceId: null,
    selectedInstanceId: null,
    instances: []
  }
}

export function hasStoredKey(instanceId: string): boolean {
  return cachedKeys.has(instanceId) || credentialFileHasContent(getKeyPath(instanceId))
}

function normalizeInstance(input: unknown): OdooInstance | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.serverUrl !== 'string' ||
    typeof record.database !== 'string' ||
    typeof record.login !== 'string' ||
    typeof record.uid !== 'number' ||
    typeof record.displayName !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    serverUrl: record.serverUrl,
    database: record.database,
    login: record.login,
    uid: record.uid,
    displayName: record.displayName
  }
}

function readInstanceFileFromDisk(): OdooInstanceFile {
  const path = getInstanceFilePath()
  if (!existsSync(path)) {
    return emptyInstanceFile()
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    ) as Partial<OdooInstanceFile>
    const instances = Array.isArray(parsed.instances)
      ? parsed.instances
          .map((instance) => normalizeInstance(instance))
          .filter((instance): instance is OdooInstance => instance !== null)
          .filter((instance) => hasStoredKey(instance.id))
      : []
    const activeInstanceId =
      typeof parsed.activeInstanceId === 'string' &&
      instances.some((instance) => instance.id === parsed.activeInstanceId)
        ? parsed.activeInstanceId
        : (instances[0]?.id ?? null)
    const selectedInstanceId =
      parsed.selectedInstanceId === 'all' ||
      (typeof parsed.selectedInstanceId === 'string' &&
        instances.some((instance) => instance.id === parsed.selectedInstanceId))
        ? parsed.selectedInstanceId
        : activeInstanceId
    return { version: 1, activeInstanceId, selectedInstanceId, instances }
  } catch {
    return emptyInstanceFile()
  }
}

export function getInstanceFile(): OdooInstanceFile {
  if (!instanceFileLoaded || !cachedInstanceFile) {
    cachedInstanceFile = readInstanceFileFromDisk()
    instanceFileLoaded = true
  }
  return cachedInstanceFile
}

export function writeInstanceFile(file: OdooInstanceFile): void {
  ensureDir(getOrcaDir())
  const instances = file.instances.filter((instance) => hasStoredKey(instance.id))
  const activeInstanceId =
    file.activeInstanceId && instances.some((instance) => instance.id === file.activeInstanceId)
      ? file.activeInstanceId
      : (instances[0]?.id ?? null)
  const selectedInstanceId =
    file.selectedInstanceId === 'all'
      ? 'all'
      : file.selectedInstanceId &&
          instances.some((instance) => instance.id === file.selectedInstanceId)
        ? file.selectedInstanceId
        : activeInstanceId

  cachedInstanceFile = { version: 1, activeInstanceId, selectedInstanceId, instances }
  instanceFileLoaded = true
  writeFileSync(getInstanceFilePath(), JSON.stringify(cachedInstanceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function writeEncryptedKey(path: string, apiKey: string): void {
  if (getSecretStore().isEncryptionAvailable()) {
    writeFileSync(path, getSecretStore().encryptString(apiKey), { mode: 0o600 })
    return
  }
  console.warn('[odoo] secret encryption unavailable — storing API key in plaintext')
  writeFileSync(path, apiKey, { encoding: 'utf-8', mode: 0o600 })
}

export function readKey(instanceId: string): string | null {
  const cached = cachedKeys.get(instanceId)
  if (cached !== undefined) {
    return cached
  }
  const path = getKeyPath(instanceId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path)
    const apiKey = readStoredCredentialToken('Odoo', raw)
    if (apiKey) {
      cachedKeys.set(instanceId, apiKey)
    }
    credentialErrors.delete(instanceId)
    return apiKey
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(instanceId, error.message)
      throw error
    }
    return null
  }
}

export function saveKey(instanceId: string, apiKey: string): void {
  ensureDir(getOrcaDir())
  ensureDir(getKeyDir())
  writeEncryptedKey(getKeyPath(instanceId), apiKey)
  cachedKeys.set(instanceId, apiKey)
  credentialErrors.delete(instanceId)
}

export function deleteKey(instanceId: string): void {
  cachedKeys.delete(instanceId)
  credentialErrors.delete(instanceId)
  try {
    unlinkSync(getKeyPath(instanceId))
  } catch {
    // Key may not exist — safe to ignore.
  }
}

/** Thrown for a server URL Orca refuses on purpose, so `connect` can quote it. */
export class OdooServerUrlError extends Error {}

export function normalizeOdooServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim()
  // Why https by default: `connect` sends the API key to whatever this resolves
  // to, so an unprefixed host must not silently downgrade to plaintext. Plain
  // http stays available for LAN and localhost, but only when typed explicitly.
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  // Anything else (ftp:, file:, …) cannot carry an Odoo JSON-RPC session and
  // would hand the key to an unrelated transport.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OdooServerUrlError('The server URL must start with https:// or http://.')
  }
  // Userinfo survives `toString()` and would land in the plaintext instance
  // file (and in `getStatus()`); the API key belongs in safeStorage only.
  if (url.username || url.password) {
    throw new OdooServerUrlError(
      'Remove the credentials from the server URL — use the Login and API key fields.'
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function getInstanceId(serverUrl: string, database: string, login: string): string {
  return createHash('sha256')
    .update(`${serverUrl}\n${database}\n${login.toLowerCase()}`)
    .digest('base64url')
    .slice(0, 24)
}

function instanceToViewer(instance: OdooInstance | null): OdooViewer | null {
  if (!instance) {
    return null
  }
  return {
    uid: instance.uid,
    displayName: instance.displayName,
    login: instance.login
  }
}

export function getStatus(): OdooConnectionStatus {
  const file = getInstanceFile()
  const instances = file.instances.filter((instance) => hasStoredKey(instance.id))
  const activeInstance =
    instances.find((instance) => instance.id === file.activeInstanceId) ?? instances[0] ?? null
  const credentialError = instances
    .map((instance) => credentialErrors.get(instance.id))
    .find((message) => message !== undefined)
  return {
    connected: instances.length > 0,
    viewer: instanceToViewer(activeInstance),
    instances,
    activeInstanceId: activeInstance?.id ?? null,
    selectedInstanceId: file.selectedInstanceId ?? activeInstance?.id ?? null,
    ...(credentialError ? { credentialError } : {})
  }
}

/** Test seam: drops cached instance/key state between test cases. */
export function resetCacheForTests(): void {
  cachedInstanceFile = null
  instanceFileLoaded = false
  cachedKeys.clear()
  credentialErrors.clear()
}
