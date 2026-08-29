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
import type { BitbucketAuthMode } from '../../shared/bitbucket-credentials'

// Why: the secret stays encrypted via safeStorage while this metadata stays
// plaintext, so status reads render the connected account without decrypting —
// otherwise every Settings open would trigger an OS keychain prompt.
export type BitbucketStoredMetadata = {
  version: 1
  authMode: BitbucketAuthMode
  email: string | null
  baseUrl: string | null
  account: string | null
  updatedAt: string
}

// Why (STA-3941): the envelope carries everything auth needs, so a torn write
// between the two files can only leave stale display metadata — never a new
// secret paired with an old email that cannot authenticate. Fields are optional
// because credentials saved before this change hold only the two tokens.
export type BitbucketStoredSecret = {
  accessToken: string | null
  apiToken: string | null
  authMode?: BitbucketAuthMode
  email?: string | null
  baseUrl?: string | null
}

export type BitbucketCredentialSaveInput = {
  authMode: BitbucketAuthMode
  email: string | null
  baseUrl: string | null
  account: string | null
  accessToken: string | null
  apiToken: string | null
}

let cachedMetadata: BitbucketStoredMetadata | null = null
let metadataLoadedFromDisk = false
let cachedSecret: BitbucketStoredSecret | null = null
let credentialError: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getMetadataPath(): string {
  return join(getOrcaDir(), 'bitbucket-credential.json')
}

function getSecretPath(): string {
  return join(getOrcaDir(), 'bitbucket-credential.enc')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// Why: hand-edited or truncated JSON must not put a non-string into an auth
// header, so every field is narrowed rather than trusted.
function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readMetadataFromDisk(): BitbucketStoredMetadata | null {
  const path = getMetadataPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BitbucketStoredMetadata>
    if (parsed.authMode !== 'token' && parsed.authMode !== 'basic') {
      return null
    }
    return {
      version: 1,
      authMode: parsed.authMode,
      email: asOptionalString(parsed.email),
      baseUrl: asOptionalString(parsed.baseUrl),
      account: asOptionalString(parsed.account),
      updatedAt: asOptionalString(parsed.updatedAt) ?? ''
    }
  } catch {
    return null
  }
}

export function getStoredBitbucketMetadata(): BitbucketStoredMetadata | null {
  if (!metadataLoadedFromDisk) {
    cachedMetadata = readMetadataFromDisk()
    metadataLoadedFromDisk = true
  }
  return cachedMetadata
}

// Cheap "is a credential saved?" check: metadata present and a non-empty secret
// file. Never decrypts, so it is safe on every status poll.
export function hasStoredBitbucketCredential(): boolean {
  return getStoredBitbucketMetadata() !== null && credentialFileHasContent(getSecretPath())
}

export function getStoredBitbucketCredentialError(): string | null {
  return credentialError
}

// Cache-first; only touches the keychain when `force` is set and the secret is
// not already in memory (mirrors Linear's `loadToken({ force })`). Throws
// CredentialDecryptionError when ciphertext cannot be decrypted.
export function loadStoredBitbucketSecret(
  options: { force?: boolean } = {}
): BitbucketStoredSecret | null {
  if (cachedSecret !== null) {
    return cachedSecret
  }
  if (!options.force) {
    return null
  }
  const path = getSecretPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = readStoredCredentialToken('Bitbucket', readFileSync(path))
    if (!token) {
      return null
    }
    const parsed = JSON.parse(token) as Partial<BitbucketStoredSecret>
    cachedSecret = {
      accessToken: asOptionalString(parsed.accessToken),
      apiToken: asOptionalString(parsed.apiToken),
      ...(parsed.authMode === 'token' || parsed.authMode === 'basic'
        ? { authMode: parsed.authMode }
        : {}),
      email: asOptionalString(parsed.email),
      baseUrl: asOptionalString(parsed.baseUrl)
    }
    credentialError = null
    return cachedSecret
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialError = error.message
      throw error
    }
    return null
  }
}

export function saveBitbucketCredential(input: BitbucketCredentialSaveInput): void {
  ensureOrcaDir()
  const secret: BitbucketStoredSecret = {
    accessToken: input.accessToken,
    apiToken: input.apiToken,
    authMode: input.authMode,
    email: input.email,
    baseUrl: input.baseUrl
  }
  writeEncryptedCredential('Bitbucket', getSecretPath(), JSON.stringify(secret))
  const metadata: BitbucketStoredMetadata = {
    version: 1,
    authMode: input.authMode,
    email: input.email,
    baseUrl: input.baseUrl,
    account: input.account,
    updatedAt: new Date().toISOString()
  }
  writeCredentialFileAtomic(
    getMetadataPath(),
    Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8')
  )
  cachedMetadata = metadata
  metadataLoadedFromDisk = true
  cachedSecret = secret
  credentialError = null
}

// Why: swallowing a non-ENOENT unlink failure would clear memory while the
// files survive, so the credential silently returns on the next launch.
export function clearStoredBitbucketCredential(): void {
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
    cachedSecret = null
    credentialError = null
  }
}

/** @internal - tests need a clean in-memory cache between cases. */
export function _resetBitbucketCredentialCache(): void {
  cachedMetadata = null
  metadataLoadedFromDisk = false
  cachedSecret = null
  credentialError = null
}
