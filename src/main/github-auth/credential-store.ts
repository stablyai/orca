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
import type { GitHubAccountAuthMethod } from '../../shared/github-account'

// Why: the secret stays encrypted via safeStorage while this metadata stays
// plaintext, so status reads render the connected account without decrypting —
// otherwise every panel open would trigger an OS keychain prompt.
export type GitHubStoredMetadata = {
  version: 1
  authMethod: GitHubAccountAuthMethod
  login: string | null
  name: string | null
  avatarUrl: string | null
  updatedAt: string
}

export type GitHubStoredSecret = {
  token: string | null
  authMethod?: GitHubAccountAuthMethod
}

export type GitHubCredentialSaveInput = {
  token: string
  authMethod: GitHubAccountAuthMethod
  login: string | null
  name: string | null
  avatarUrl: string | null
}

let cachedMetadata: GitHubStoredMetadata | null = null
let metadataLoadedFromDisk = false
let cachedSecret: GitHubStoredSecret | null = null
let credentialError: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getMetadataPath(): string {
  return join(getOrcaDir(), 'github-credential.json')
}

function getSecretPath(): string {
  return join(getOrcaDir(), 'github-credential.enc')
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

function readMetadataFromDisk(): GitHubStoredMetadata | null {
  const path = getMetadataPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GitHubStoredMetadata>
    if (parsed.authMethod !== 'device-flow' && parsed.authMethod !== 'pat') {
      return null
    }
    return {
      version: 1,
      authMethod: parsed.authMethod,
      login: asOptionalString(parsed.login),
      name: asOptionalString(parsed.name),
      avatarUrl: asOptionalString(parsed.avatarUrl),
      updatedAt: asOptionalString(parsed.updatedAt) ?? ''
    }
  } catch {
    return null
  }
}

export function getStoredGitHubMetadata(): GitHubStoredMetadata | null {
  if (!metadataLoadedFromDisk) {
    cachedMetadata = readMetadataFromDisk()
    metadataLoadedFromDisk = true
  }
  return cachedMetadata
}

// Cheap "is a credential saved?" check: metadata present and a non-empty secret
// file. Never decrypts, so it is safe on every status poll.
export function hasStoredGitHubCredential(): boolean {
  return getStoredGitHubMetadata() !== null && credentialFileHasContent(getSecretPath())
}

export function getStoredGitHubCredentialError(): string | null {
  return credentialError
}

// Cache-first; only touches the keychain when `force` is set and the secret is
// not already in memory (mirrors Bitbucket's loadStoredBitbucketSecret).
export function loadStoredGitHubSecret(
  options: { force?: boolean } = {}
): GitHubStoredSecret | null {
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
    const raw = readStoredCredentialToken('GitHub', readFileSync(path))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<GitHubStoredSecret>
    cachedSecret = {
      token: asOptionalString(parsed.token),
      ...(parsed.authMethod === 'device-flow' || parsed.authMethod === 'pat'
        ? { authMethod: parsed.authMethod }
        : {})
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

export function saveGitHubCredential(input: GitHubCredentialSaveInput): void {
  ensureOrcaDir()
  const secret: GitHubStoredSecret = {
    token: input.token,
    authMethod: input.authMethod
  }
  writeEncryptedCredential('GitHub', getSecretPath(), JSON.stringify(secret))
  const metadata: GitHubStoredMetadata = {
    version: 1,
    authMethod: input.authMethod,
    login: input.login,
    name: input.name,
    avatarUrl: input.avatarUrl,
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
export function clearStoredGitHubCredential(): void {
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
export function _resetGitHubCredentialCache(): void {
  cachedMetadata = null
  metadataLoadedFromDisk = false
  cachedSecret = null
  credentialError = null
}
