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
import { readCredentialFileProtection } from '../credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

// Why: separate files from the Cloud credential so both can be connected at once
// and the Cloud on-disk format stays untouched.
export type BitbucketServerStoredMetadata = {
  version: 1
  baseUrl: string
  account: string | null
  updatedAt: string
}

export type BitbucketServerStoredSecret = {
  accessToken: string | null
  baseUrl: string | null
}

export type BitbucketServerCredentialSaveInput = {
  baseUrl: string
  account: string | null
  accessToken: string
}

let cachedMetadata: BitbucketServerStoredMetadata | null = null
let metadataLoadedFromDisk = false
let cachedSecret: BitbucketServerStoredSecret | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getMetadataPath(): string {
  return join(getOrcaDir(), 'bitbucket-server-credential.json')
}

export function getBitbucketServerSecretPath(): string {
  return join(getOrcaDir(), 'bitbucket-server-credential.enc')
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readMetadataFromDisk(): BitbucketServerStoredMetadata | null {
  const path = getMetadataPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || !('baseUrl' in parsed)) {
      return null
    }
    const baseUrl = asOptionalString(parsed.baseUrl)
    if (!baseUrl) {
      return null
    }
    return {
      version: 1,
      baseUrl,
      account: 'account' in parsed ? asOptionalString(parsed.account) : null,
      updatedAt: ('updatedAt' in parsed ? asOptionalString(parsed.updatedAt) : null) ?? ''
    }
  } catch {
    return null
  }
}

export function getStoredBitbucketServerMetadata(): BitbucketServerStoredMetadata | null {
  if (!metadataLoadedFromDisk) {
    cachedMetadata = readMetadataFromDisk()
    metadataLoadedFromDisk = true
  }
  return cachedMetadata
}

// Never decrypts, so status polls and repo detection stay free of keychain prompts.
export function hasStoredBitbucketServerCredential(): boolean {
  return (
    getStoredBitbucketServerMetadata() !== null &&
    credentialFileHasContent(getBitbucketServerSecretPath())
  )
}

// Throws CredentialDecryptionError when the ciphertext cannot be decrypted.
export function loadStoredBitbucketServerSecret(): BitbucketServerStoredSecret | null {
  if (cachedSecret !== null) {
    return cachedSecret
  }
  const path = getBitbucketServerSecretPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = readStoredCredentialToken('Bitbucket', readFileSync(path))
    if (!token) {
      return null
    }
    const parsed: unknown = JSON.parse(token)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    cachedSecret = {
      accessToken: 'accessToken' in parsed ? asOptionalString(parsed.accessToken) : null,
      baseUrl: 'baseUrl' in parsed ? asOptionalString(parsed.baseUrl) : null
    }
    return cachedSecret
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      throw error
    }
    return null
  }
}

export function getBitbucketServerCredentialProtection(): SecretAtRestProtection | null {
  return readCredentialFileProtection(getBitbucketServerSecretPath())
}

export function saveBitbucketServerCredential(input: BitbucketServerCredentialSaveInput): void {
  if (!existsSync(getOrcaDir())) {
    mkdirSync(getOrcaDir(), { recursive: true })
  }
  const secret: BitbucketServerStoredSecret = {
    accessToken: input.accessToken,
    baseUrl: input.baseUrl
  }
  writeEncryptedCredential('Bitbucket', getBitbucketServerSecretPath(), JSON.stringify(secret))
  const metadata: BitbucketServerStoredMetadata = {
    version: 1,
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
}

export function clearStoredBitbucketServerCredential(): void {
  try {
    for (const path of [getBitbucketServerSecretPath(), getMetadataPath()]) {
      try {
        unlinkSync(path)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
    }
  } finally {
    // Why: drop caches even on a partial delete so the session stops using a credential the user removed.
    cachedMetadata = null
    metadataLoadedFromDisk = true
    cachedSecret = null
  }
}
