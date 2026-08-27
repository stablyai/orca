import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeCredentialFileAtomic,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { KanbanStoredMetadata, KanbanViewer } from '../../shared/kanban-types'

// Why: the token stays encrypted via safeStorage while this metadata stays
// plaintext, so status reads render the connected viewer without decrypting —
// otherwise every status poll would trigger an OS keychain prompt.

let cachedMetadata: KanbanStoredMetadata | null = null
let metadataLoadedFromDisk = false
let cachedToken: string | null = null
let credentialError: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getMetadataPath(): string {
  return join(getOrcaDir(), 'kanban-credential.json')
}

function getSecretPath(): string {
  return join(getOrcaDir(), 'kanban-credential.enc')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// Why: hand-edited or truncated JSON must not put a non-string into the
// metadata, so every field is narrowed rather than trusted.
function asOptionalString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readMetadataFromDisk(): KanbanStoredMetadata | null {
  const path = getMetadataPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<KanbanStoredMetadata>
    // Why: a stale file that still holds a `version` key is tolerated — the
    // unknown key is ignored, never migrated, and never causes a throw.
    return {
      viewerId: asOptionalString(parsed.viewerId),
      viewerName: asOptionalString(parsed.viewerName),
      viewerLevel: asOptionalString(parsed.viewerLevel),
      updatedAt: asOptionalString(parsed.updatedAt)
    }
  } catch {
    return null
  }
}

export function getStoredKanbanMetadata(): KanbanStoredMetadata | null {
  if (!metadataLoadedFromDisk) {
    cachedMetadata = readMetadataFromDisk()
    metadataLoadedFromDisk = true
  }
  return cachedMetadata
}

// Cheap "is a credential saved?" check: metadata present and a non-empty secret
// file. Never decrypts, so it is safe on every status poll.
export function hasStoredKanbanCredential(): boolean {
  return getStoredKanbanMetadata() !== null && credentialFileHasContent(getSecretPath())
}

export function getStoredKanbanCredentialError(): string | null {
  return credentialError
}

// Cache-first; only touches the keychain when `force` is set and the token is
// not already in memory. Throws CredentialDecryptionError when ciphertext
// cannot be decrypted; the message never contains ciphertext or the token.
export function loadStoredKanbanToken(options: { force?: boolean } = {}): string | null {
  if (cachedToken !== null) {
    return cachedToken
  }
  if (!options.force) {
    return null
  }
  const path = getSecretPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = readStoredCredentialToken('Kanban', readFileSync(path))
    if (token) {
      cachedToken = token
    }
    credentialError = null
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialError = error.message
      throw error
    }
    return null
  }
}

export function saveKanbanCredential(input: { token: string; viewer: KanbanViewer }): void {
  ensureOrcaDir()
  writeEncryptedCredential('Kanban', getSecretPath(), input.token)
  const metadata: KanbanStoredMetadata = {
    viewerId: input.viewer.id,
    viewerName: input.viewer.name,
    viewerLevel: input.viewer.level,
    updatedAt: new Date().toISOString()
  }
  writeCredentialFileAtomic(
    getMetadataPath(),
    Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8')
  )
  cachedMetadata = metadata
  metadataLoadedFromDisk = true
  cachedToken = input.token
  credentialError = null
}

// Why: swallowing a non-ENOENT unlink failure would clear memory while the
// files survive, so the credential silently returns on the next launch.
export function clearStoredKanbanCredential(): void {
  try {
    for (const path of [getSecretPath(), getMetadataPath()]) {
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
  } finally {
    // Why: on a partial delete the caches must still be dropped, or the session
    // keeps authenticating with a credential the user just disconnected.
    cachedMetadata = null
    metadataLoadedFromDisk = true
    cachedToken = null
    credentialError = null
  }
}

/** @internal - tests need a clean in-memory cache between cases. */
export function _resetKanbanCredentialCache(): void {
  cachedMetadata = null
  metadataLoadedFromDisk = false
  cachedToken = null
  credentialError = null
}
