import { mkdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeCredentialFileAtomic,
  writeEncryptedCredential
} from '../credentials/integration-credential-file'
import { readCredentialFileProtection } from '../credentials/credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'

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
// A read that started before a save or clear must not repopulate the cache with the old value.
let cacheGeneration = 0

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

async function readMetadataFromDisk(): Promise<BitbucketServerStoredMetadata | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(getMetadataPath(), 'utf-8'))
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

export async function getStoredBitbucketServerMetadata(): Promise<BitbucketServerStoredMetadata | null> {
  if (metadataLoadedFromDisk) {
    return cachedMetadata
  }
  const generation = cacheGeneration
  const metadata = await readMetadataFromDisk()
  if (generation !== cacheGeneration) {
    return cachedMetadata
  }
  cachedMetadata = metadata
  metadataLoadedFromDisk = true
  return metadata
}

// Never decrypts, so status polls and repo detection stay free of keychain prompts.
export async function hasStoredBitbucketServerCredential(): Promise<boolean> {
  return (
    (await getStoredBitbucketServerMetadata()) !== null &&
    credentialFileHasContent(getBitbucketServerSecretPath())
  )
}

// Throws CredentialDecryptionError when the ciphertext cannot be decrypted.
export async function loadStoredBitbucketServerSecret(): Promise<BitbucketServerStoredSecret | null> {
  if (cachedSecret !== null) {
    return cachedSecret
  }
  const generation = cacheGeneration
  let ciphertext: Buffer
  try {
    ciphertext = await readFile(getBitbucketServerSecretPath())
  } catch {
    return null
  }
  try {
    const token = readStoredCredentialToken('Bitbucket', ciphertext)
    if (!token) {
      return null
    }
    const parsed: unknown = JSON.parse(token)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const secret: BitbucketServerStoredSecret = {
      accessToken: 'accessToken' in parsed ? asOptionalString(parsed.accessToken) : null,
      baseUrl: 'baseUrl' in parsed ? asOptionalString(parsed.baseUrl) : null
    }
    if (generation === cacheGeneration) {
      cachedSecret = secret
    }
    return secret
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

export async function saveBitbucketServerCredential(
  input: BitbucketServerCredentialSaveInput
): Promise<void> {
  await mkdir(getOrcaDir(), { recursive: true })
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
  cacheGeneration++
  cachedMetadata = metadata
  metadataLoadedFromDisk = true
  cachedSecret = secret
}

export async function clearStoredBitbucketServerCredential(): Promise<void> {
  try {
    for (const path of [getBitbucketServerSecretPath(), getMetadataPath()]) {
      try {
        await unlink(path)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
    }
  } finally {
    // Why: drop caches even on a partial delete so the session stops using a credential the user removed.
    cacheGeneration++
    cachedMetadata = null
    metadataLoadedFromDisk = true
    cachedSecret = null
  }
}
