import { readFile, rm } from 'node:fs/promises'
import { stageCredentialFile } from '../../credentials/credential-file-io'
import { join } from 'node:path'
import { getSecretStore, type SecretStore } from '../../../shared/secure-storage/secret-store'
import {
  OrcaCloudSessionStorageRefusedError,
  sealedStorageRefusal
} from './profile-cloud-session-sealing'
import { isUnreadableError } from '../../../shared/secure-storage/secure-file'
import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaCloudSessionPersistence
} from '../../../shared/orca-profiles/orca-profiles'
import { getOrcaProfileDirectory } from '../profile-storage-paths'
import { allowsPlaintextOrcaCloudSession } from '../cloud-auth/profile-cloud-auth-config'

export type OrcaCloudSession = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  capabilities: OrcaCloudCapabilities
  organizations?: OrcaCloudOrgSummary[]
  /** Whose tokens these are, so a profile linked to someone else never uses them. Absent on older files. */
  identity?: OrcaCloudSessionIdentity
}

export type OrcaCloudSessionIdentity = { userId: string; cloudProfileId: string }

export type OrcaCloudSessionReadResult =
  | {
      status: 'found'
      session: OrcaCloudSession
      persistence: Exclude<OrcaCloudSessionPersistence, 'none'>
    }
  | { status: 'missing'; persistence: 'none' }
  | { status: 'decrypt-failed'; persistence: 'none'; error: string }
  /** Unlike decrypt-failed, unreadable proves nothing and must not authorize replacement. */
  | { status: 'unreadable'; persistence: 'none'; error: string }

// orcad's host-key seal gets its own tag so a data folder shared with a desktop fails clearly, not as a decrypt error.
type SealedSessionFormat = 'electron-safe-storage-v1' | 'orcad-host-key-v1'

type PersistedEncryptedSession = {
  version: 1
  format: SealedSessionFormat
  savedAt: number
  ciphertext: string
}

type PersistedPlaintextSession = {
  version: 1
  format: 'dev-plaintext-v1'
  savedAt: number
  session: OrcaCloudSession
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
  if (
    value.identity !== undefined &&
    !(
      isObject(value.identity) &&
      typeof value.identity.userId === 'string' &&
      typeof value.identity.cloudProfileId === 'string'
    )
  ) {
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

function sealedSessionFormat(secrets: SecretStore): SealedSessionFormat {
  return secrets.describeSealing?.().kind === 'host-key'
    ? 'orcad-host-key-v1'
    : 'electron-safe-storage-v1'
}

export async function writeOrcaCloudSessionFile(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession,
  requireSealed = false
): Promise<OrcaCloudSessionPersistence> {
  const secrets = getSecretStore()
  // Checked at write time: the store can change while a remote sign-in waits on the browser.
  const refusal = requireSealed ? sealedStorageRefusal(secrets) : null
  if (refusal) {
    throw new OrcaCloudSessionStorageRefusedError(refusal)
  }
  if (secrets.isEncryptionAvailable() && secrets.describeSealing?.().kind !== 'none') {
    const encrypted: PersistedEncryptedSession = {
      version: 1,
      format: sealedSessionFormat(secrets),
      savedAt: Date.now(),
      ciphertext: secrets.encryptString(JSON.stringify(session)).toString('base64')
    }
    await stageCredentialFile(
      getOrcaCloudSessionPath(profileId, userDataPath),
      JSON.stringify(encrypted, null, 2),
      { createDirectory: true }
    )
    return 'encrypted'
  }

  if (allowsPlaintextOrcaCloudSession()) {
    const plaintext: PersistedPlaintextSession = {
      version: 1,
      format: 'dev-plaintext-v1',
      savedAt: Date.now(),
      session
    }
    await stageCredentialFile(
      getOrcaCloudSessionPath(profileId, userDataPath),
      JSON.stringify(plaintext, null, 2),
      { createDirectory: true }
    )
    return 'dev-plaintext'
  }

  // A new sign-in or rotation supersedes the old disk session, even when the new tokens stay in memory.
  await rm(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
  return 'memory-only'
}

export async function readOrcaCloudSessionFile(
  profileId: string,
  userDataPath: string
): Promise<OrcaCloudSessionReadResult> {
  const path = getOrcaCloudSessionPath(profileId, userDataPath)

  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as
      | PersistedEncryptedSession
      | PersistedPlaintextSession
    if (parsed.version !== 1) {
      return { status: 'decrypt-failed', persistence: 'none', error: 'Unsupported session format.' }
    }
    if (parsed.format === 'electron-safe-storage-v1' || parsed.format === 'orcad-host-key-v1') {
      const secrets = getSecretStore()
      if (parsed.format !== sealedSessionFormat(secrets)) {
        return {
          status: 'decrypt-failed',
          persistence: 'none',
          error:
            parsed.format === 'orcad-host-key-v1'
              ? "This Orca account sign-in was saved by Orca's headless server. Sign in again here."
              : 'This Orca account sign-in was saved by the Orca app. Sign in again on this server.'
        }
      }
      if (!secrets.isEncryptionAvailable()) {
        return {
          status: 'decrypt-failed',
          persistence: 'none',
          error: 'OS-backed encryption is unavailable.'
        }
      }
      const decrypted = secrets.decryptString(Buffer.from(parsed.ciphertext, 'base64'))
      const session = JSON.parse(decrypted) as OrcaCloudSession
      if (!isOrcaCloudSession(session)) {
        return { status: 'decrypt-failed', persistence: 'none', error: 'Invalid saved session.' }
      }
      return { status: 'found', session, persistence: 'encrypted' }
    }
    if (parsed.format === 'dev-plaintext-v1' && allowsPlaintextOrcaCloudSession()) {
      if (!isOrcaCloudSession(parsed.session)) {
        return { status: 'decrypt-failed', persistence: 'none', error: 'Invalid saved session.' }
      }
      return { status: 'found', session: parsed.session, persistence: 'dev-plaintext' }
    }
    return { status: 'decrypt-failed', persistence: 'none', error: 'Unsafe session format.' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', persistence: 'none' }
    }
    if (isUnreadableError(error)) {
      return {
        status: 'unreadable',
        persistence: 'none',
        error: 'Cannot read the saved Orca account session: the read failed.'
      }
    }
    return {
      status: 'decrypt-failed',
      persistence: 'none',
      error: 'Could not decrypt saved Orca account session.'
    }
  }
}
