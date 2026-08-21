import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { writeSecureJsonFile } from '../../shared/secure-file'
import type {
  MCodeCloudCapabilities,
  MCodeCloudOrgSummary,
  MCodeCloudSessionPersistence
} from '../../shared/mcode-profiles'
import { getMCodeProfileDirectory } from './profile-storage-paths'
import { allowsPlaintextMCodeCloudSession } from './profile-cloud-auth-config'
import type { MCodeCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  cloudSessionIdentity,
  isCloudSessionMutationCurrent,
  recordSuccessfulCloudSessionLogin,
  type CloudSessionMutationSnapshot
} from './profile-cloud-session-mutation'

export type MCodeCloudSession = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  capabilities: MCodeCloudCapabilities
  organizations?: MCodeCloudOrgSummary[]
}

export type MCodeCloudSessionReadResult =
  | { status: 'found'; session: MCodeCloudSession; persistence: MCodeCloudSessionPersistence }
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
  session: MCodeCloudSession
}

type CachedMCodeCloudSession = {
  session: MCodeCloudSession
  persistence: Exclude<MCodeCloudSessionPersistence, 'none'>
}

const memorySessions = new Map<string, CachedMCodeCloudSession>()

function sessionCacheKey(profileId: string, userDataPath: string): string {
  return `${userDataPath}\0${profileId}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMCodeCloudSession(value: unknown): value is MCodeCloudSession {
  if (!isObject(value) || !isObject(value.capabilities) || !isObject(value.capabilities.flags)) {
    return false
  }
  if (value.organizations !== undefined && !isMCodeCloudOrganizations(value.organizations)) {
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

function isMCodeCloudOrganizations(value: unknown): value is MCodeCloudOrgSummary[] {
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

export function getMCodeCloudSessionPath(profileId: string, userDataPath: string): string {
  return join(getMCodeProfileDirectory(profileId, userDataPath), 'account-session.json.enc')
}

export function saveMCodeCloudSession(
  profileId: string,
  userDataPath: string,
  session: MCodeCloudSession
): MCodeCloudSessionPersistence {
  const cacheKey = sessionCacheKey(profileId, userDataPath)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted: PersistedEncryptedSession = {
      version: 1,
      format: 'electron-safe-storage-v1',
      savedAt: Date.now(),
      ciphertext: safeStorage.encryptString(JSON.stringify(session)).toString('base64')
    }
    writeSecureJsonFile(getMCodeCloudSessionPath(profileId, userDataPath), encrypted)
    memorySessions.set(cacheKey, { session, persistence: 'encrypted' })
    return 'encrypted'
  }

  if (allowsPlaintextMCodeCloudSession()) {
    const plaintext: PersistedPlaintextSession = {
      version: 1,
      format: 'dev-plaintext-v1',
      savedAt: Date.now(),
      session
    }
    writeSecureJsonFile(getMCodeCloudSessionPath(profileId, userDataPath), plaintext)
    memorySessions.set(cacheKey, { session, persistence: 'dev-plaintext' })
    return 'dev-plaintext'
  }

  // Why: MCode account refresh tokens must not silently fall back to plaintext
  // in production. Memory-only keeps cloud features usable until restart.
  memorySessions.set(cacheKey, { session, persistence: 'memory-only' })
  return 'memory-only'
}

export function saveMCodeCloudSessionExchange(
  profileId: string,
  userDataPath: string,
  exchange: MCodeCloudSessionExchangeResponse
): MCodeCloudSessionPersistence {
  recordSuccessfulCloudSessionLogin(cloudSessionIdentity(profileId, exchange.cloud), userDataPath)
  return saveMCodeCloudSession(profileId, userDataPath, {
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken,
    expiresAt: exchange.expiresAt,
    organizations: exchange.organizations,
    capabilities: exchange.capabilities
  })
}

export function saveMCodeCloudSessionIfCurrent(
  profileId: string,
  userDataPath: string,
  session: MCodeCloudSession,
  snapshot: CloudSessionMutationSnapshot
): MCodeCloudSessionPersistence | null {
  // Why: the check and sync save share one main-process turn, so an async
  // refresh captured before sign-out/org-switch cannot resurrect the session.
  if (!isCloudSessionMutationCurrent(profileId, userDataPath, snapshot)) {
    return null
  }
  return saveMCodeCloudSession(profileId, userDataPath, session)
}

export function readMCodeCloudSession(
  profileId: string,
  userDataPath: string
): MCodeCloudSessionReadResult {
  const cacheKey = sessionCacheKey(profileId, userDataPath)
  const memorySession = memorySessions.get(cacheKey)
  if (memorySession) {
    return {
      status: 'found',
      session: memorySession.session,
      persistence: memorySession.persistence
    }
  }

  const path = getMCodeCloudSessionPath(profileId, userDataPath)
  if (!existsSync(path)) {
    return { status: 'missing', persistence: 'none' }
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as
      | PersistedEncryptedSession
      | PersistedPlaintextSession
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
      const session = JSON.parse(decrypted) as MCodeCloudSession
      if (!isMCodeCloudSession(session)) {
        return { status: 'decrypt-failed', persistence: 'none', error: 'Invalid saved session.' }
      }
      memorySessions.set(cacheKey, { session, persistence: 'encrypted' })
      return { status: 'found', session, persistence: 'encrypted' }
    }
    if (parsed.format === 'dev-plaintext-v1' && allowsPlaintextMCodeCloudSession()) {
      if (!isMCodeCloudSession(parsed.session)) {
        return { status: 'decrypt-failed', persistence: 'none', error: 'Invalid saved session.' }
      }
      memorySessions.set(cacheKey, { session: parsed.session, persistence: 'dev-plaintext' })
      return { status: 'found', session: parsed.session, persistence: 'dev-plaintext' }
    }
    return { status: 'decrypt-failed', persistence: 'none', error: 'Unsafe session format.' }
  } catch {
    return {
      status: 'decrypt-failed',
      persistence: 'none',
      error: 'Could not decrypt saved MCode account session.'
    }
  }
}

export function clearMCodeCloudSession(profileId: string, userDataPath: string): void {
  memorySessions.delete(sessionCacheKey(profileId, userDataPath))
  rmSync(getMCodeCloudSessionPath(profileId, userDataPath), { force: true })
}
