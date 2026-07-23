import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../shared/node-bounded-json-stringify'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaCloudSessionPersistence
} from '../../shared/orca-profiles'
import { getOrcaProfileDirectory } from './profile-storage-paths'
import { allowsPlaintextOrcaCloudSession } from './profile-cloud-auth-config'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  cloudSessionIdentity,
  isCloudSessionMutationCurrent,
  recordSuccessfulCloudSessionLogin,
  type CloudSessionMutationSnapshot
} from './profile-cloud-session-mutation'

export type OrcaCloudSession = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  capabilities: OrcaCloudCapabilities
  organizations?: OrcaCloudOrgSummary[]
}

export type OrcaCloudSessionReadResult =
  | { status: 'found'; session: OrcaCloudSession; persistence: OrcaCloudSessionPersistence }
  | { status: 'missing'; persistence: 'none' }
  | { status: 'decrypt-failed'; persistence: 'none'; error: string }

type PersistedEncryptedSession = {
  version: 1
  format: 'electron-safe-storage-v1'
  savedAt: number
  ciphertext: string
}

type PersistedPlaintextSession = {
  version: 1
  format: 'dev-plaintext-v1'
  savedAt: number
  session: OrcaCloudSession
}

type CachedOrcaCloudSession = {
  session: OrcaCloudSession
  persistence: Exclude<OrcaCloudSessionPersistence, 'none'>
  bytes: number
}

const memorySessions = new Map<string, CachedOrcaCloudSession>()
export const MAX_ORCA_CLOUD_SESSION_FILE_BYTES = 1024 * 1024
export const MAX_ORCA_CLOUD_SESSION_PAYLOAD_BYTES = MAX_ORCA_CLOUD_SESSION_FILE_BYTES
export const MAX_ORCA_CLOUD_MEMORY_SESSIONS = 128
export const MAX_ORCA_CLOUD_MEMORY_SESSION_BYTES = 16 * 1024 * 1024
let memorySessionBytes = 0

function sessionCacheKey(profileId: string, userDataPath: string): string {
  return `${userDataPath}\0${profileId}`
}

function rememberMemorySession(
  cacheKey: string,
  session: OrcaCloudSession,
  persistence: Exclude<OrcaCloudSessionPersistence, 'none'>,
  bytes: number
): void {
  const previous = memorySessions.get(cacheKey)
  if (previous) {
    memorySessionBytes -= previous.bytes
    memorySessions.delete(cacheKey)
  }
  while (
    memorySessions.size >= MAX_ORCA_CLOUD_MEMORY_SESSIONS ||
    memorySessionBytes + bytes > MAX_ORCA_CLOUD_MEMORY_SESSION_BYTES
  ) {
    const oldestKey = memorySessions.keys().next().value as string | undefined
    if (oldestKey === undefined) {
      break
    }
    const oldest = memorySessions.get(oldestKey)
    memorySessions.delete(oldestKey)
    memorySessionBytes -= oldest?.bytes ?? 0
  }
  memorySessions.set(cacheKey, { session, persistence, bytes })
  memorySessionBytes += bytes
}

function serializedSessionWithinLimit(
  session: OrcaCloudSession,
  maxBytes = MAX_ORCA_CLOUD_SESSION_PAYLOAD_BYTES
): { serialized: string; byteLength: number } {
  return stringifyJsonWithinByteLimit(session, maxBytes)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOrcaCloudSession(value: unknown): value is OrcaCloudSession {
  if (!isObject(value) || !isObject(value.capabilities) || !isObject(value.capabilities.flags)) {
    return false
  }
  if (value.organizations !== undefined && !isOrcaCloudOrganizations(value.organizations)) {
    return false
  }
  return (
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    typeof value.refreshToken === 'string' &&
    value.refreshToken.length > 0 &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    typeof value.capabilities.refreshedAt === 'number' &&
    Number.isFinite(value.capabilities.refreshedAt)
  )
}

function isOrcaCloudOrganizations(value: unknown): value is OrcaCloudOrgSummary[] {
  if (!Array.isArray(value)) {
    return false
  }
  return value.every((organization) => {
    if (!isObject(organization)) {
      return false
    }
    return (
      typeof organization.orgId === 'string' &&
      organization.orgId.length > 0 &&
      typeof organization.name === 'string' &&
      organization.name.length > 0 &&
      (organization.role === undefined || typeof organization.role === 'string')
    )
  })
}

export function getOrcaCloudSessionPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'account-session.json.enc')
}

export function saveOrcaCloudSession(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession
): OrcaCloudSessionPersistence {
  const cacheKey = sessionCacheKey(profileId, userDataPath)
  const payload = serializedSessionWithinLimit(session)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted: PersistedEncryptedSession = {
      version: 1,
      format: 'electron-safe-storage-v1',
      savedAt: Date.now(),
      ciphertext: safeStorage.encryptString(payload.serialized).toString('base64')
    }
    try {
      writeSecureJsonFileWithinLimit(
        getOrcaCloudSessionPath(profileId, userDataPath),
        encrypted,
        MAX_ORCA_CLOUD_SESSION_FILE_BYTES
      )
    } catch (error) {
      if (!(error instanceof JsonStringifyByteLimitError)) {
        throw error
      }
      rmSync(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
      rememberMemorySession(cacheKey, session, 'memory-only', payload.byteLength)
      return 'memory-only'
    }
    rememberMemorySession(cacheKey, session, 'encrypted', payload.byteLength)
    return 'encrypted'
  }

  if (allowsPlaintextOrcaCloudSession()) {
    const plaintext: PersistedPlaintextSession = {
      version: 1,
      format: 'dev-plaintext-v1',
      savedAt: Date.now(),
      session
    }
    try {
      writeSecureJsonFileWithinLimit(
        getOrcaCloudSessionPath(profileId, userDataPath),
        plaintext,
        MAX_ORCA_CLOUD_SESSION_FILE_BYTES
      )
    } catch (error) {
      if (!(error instanceof JsonStringifyByteLimitError)) {
        throw error
      }
      rmSync(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
      rememberMemorySession(cacheKey, session, 'memory-only', payload.byteLength)
      return 'memory-only'
    }
    rememberMemorySession(cacheKey, session, 'dev-plaintext', payload.byteLength)
    return 'dev-plaintext'
  }

  // Why: Orca account refresh tokens must not silently fall back to plaintext
  // in production. Memory-only keeps cloud features usable until restart.
  rememberMemorySession(cacheKey, session, 'memory-only', payload.byteLength)
  return 'memory-only'
}

export function saveOrcaCloudSessionExchange(
  profileId: string,
  userDataPath: string,
  exchange: OrcaCloudSessionExchangeResponse
): OrcaCloudSessionPersistence {
  recordSuccessfulCloudSessionLogin(cloudSessionIdentity(profileId, exchange.cloud), userDataPath)
  return saveOrcaCloudSession(profileId, userDataPath, {
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken,
    expiresAt: exchange.expiresAt,
    organizations: exchange.organizations,
    capabilities: exchange.capabilities
  })
}

export function saveOrcaCloudSessionIfCurrent(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession,
  snapshot: CloudSessionMutationSnapshot
): OrcaCloudSessionPersistence | null {
  // Why: the check and sync save share one main-process turn, so an async
  // refresh captured before sign-out/org-switch cannot resurrect the session.
  if (!isCloudSessionMutationCurrent(profileId, userDataPath, snapshot)) {
    return null
  }
  return saveOrcaCloudSession(profileId, userDataPath, session)
}

export function readOrcaCloudSession(
  profileId: string,
  userDataPath: string
): OrcaCloudSessionReadResult {
  const cacheKey = sessionCacheKey(profileId, userDataPath)
  const memorySession = memorySessions.get(cacheKey)
  if (memorySession) {
    memorySessions.delete(cacheKey)
    memorySessions.set(cacheKey, memorySession)
    return {
      status: 'found',
      session: memorySession.session,
      persistence: memorySession.persistence
    }
  }

  const path = getOrcaCloudSessionPath(profileId, userDataPath)
  if (!existsSync(path)) {
    return { status: 'missing', persistence: 'none' }
  }

  try {
    const parsed = JSON.parse(
      readNodeFileSyncWithinLimit(path, MAX_ORCA_CLOUD_SESSION_FILE_BYTES).buffer.toString('utf8')
    ) as PersistedEncryptedSession | PersistedPlaintextSession
    if (parsed.version !== 1) {
      return { status: 'decrypt-failed', persistence: 'none', error: 'Unsupported session format.' }
    }
    if (parsed.format === 'electron-safe-storage-v1') {
      if (!safeStorage.isEncryptionAvailable()) {
        return {
          status: 'decrypt-failed',
          persistence: 'none',
          error: 'OS-backed encryption is unavailable.'
        }
      }
      const decrypted = safeStorage.decryptString(Buffer.from(parsed.ciphertext, 'base64'))
      const session = JSON.parse(decrypted) as OrcaCloudSession
      if (!isOrcaCloudSession(session)) {
        return { status: 'decrypt-failed', persistence: 'none', error: 'Invalid saved session.' }
      }
      const payload = serializedSessionWithinLimit(session, MAX_ORCA_CLOUD_SESSION_FILE_BYTES)
      rememberMemorySession(cacheKey, session, 'encrypted', payload.byteLength)
      return { status: 'found', session, persistence: 'encrypted' }
    }
    if (parsed.format === 'dev-plaintext-v1' && allowsPlaintextOrcaCloudSession()) {
      if (!isOrcaCloudSession(parsed.session)) {
        return { status: 'decrypt-failed', persistence: 'none', error: 'Invalid saved session.' }
      }
      const payload = serializedSessionWithinLimit(
        parsed.session,
        MAX_ORCA_CLOUD_SESSION_FILE_BYTES
      )
      rememberMemorySession(cacheKey, parsed.session, 'dev-plaintext', payload.byteLength)
      return { status: 'found', session: parsed.session, persistence: 'dev-plaintext' }
    }
    return { status: 'decrypt-failed', persistence: 'none', error: 'Unsafe session format.' }
  } catch {
    return {
      status: 'decrypt-failed',
      persistence: 'none',
      error: 'Could not decrypt saved Orca account session.'
    }
  }
}

export function clearOrcaCloudSession(profileId: string, userDataPath: string): void {
  const cacheKey = sessionCacheKey(profileId, userDataPath)
  const cached = memorySessions.get(cacheKey)
  if (cached) {
    memorySessionBytes -= cached.bytes
    memorySessions.delete(cacheKey)
  }
  rmSync(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
}
