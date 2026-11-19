import { inCredentialFileOrder, credentialFileExists } from '../credentials/credential-file-io'
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
import type { BitbucketAuthMode } from '../../shared/bitbucket/bitbucket-credentials'
import { readCredentialFileProtection } from '../credentials/credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'

// Plaintext display metadata lets status reads avoid keychain prompts.
export type BitbucketStoredMetadata = {
  version: 1
  authMode: BitbucketAuthMode
  email: string | null
  baseUrl: string | null
  account: string | null
  updatedAt: string
}

// Envelope auth fields prevent torn identity/secret pairs; optional fields support legacy files.
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

export function getSecretPath(): string {
  return join(getOrcaDir(), 'bitbucket-credential.enc')
}

async function ensureOrcaDir(): Promise<void> {
  const dir = getOrcaDir()
  if (!(await credentialFileExists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

async function readMetadataFromDisk(): Promise<BitbucketStoredMetadata | null> {
  const path = getMetadataPath()
  if (!(await credentialFileExists(path))) {
    return null
  }
  try {
    const parsed: Partial<BitbucketStoredMetadata> = JSON.parse(await readFile(path, 'utf-8'))
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

async function loadMetadata(): Promise<BitbucketStoredMetadata | null> {
  if (!metadataLoadedFromDisk) {
    cachedMetadata = await readMetadataFromDisk()
    metadataLoadedFromDisk = true
  }
  return cachedMetadata
}

export async function getStoredBitbucketMetadata(): Promise<BitbucketStoredMetadata | null> {
  return inCredentialFileOrder(`${getSecretPath()}.mutation`, loadMetadata)
}

// Presence checks must avoid keychain prompts.
export async function hasStoredBitbucketCredential(): Promise<boolean> {
  return (
    (await getStoredBitbucketMetadata()) !== null &&
    (await credentialFileHasContent(getSecretPath()))
  )
}

export function getStoredBitbucketCredentialError(): string | null {
  return credentialError
}

// Without force, read memory only; forced decryption can throw CredentialDecryptionError.
export async function loadStoredBitbucketSecret(
  options: { force?: boolean } = {}
): Promise<BitbucketStoredSecret | null> {
  return inCredentialFileOrder(`${getSecretPath()}.mutation`, () => loadSecret(options))
}

export async function loadStoredBitbucketCredential(options: { force?: boolean } = {}): Promise<{
  secret: BitbucketStoredSecret | null
  metadata: BitbucketStoredMetadata | null
}> {
  return inCredentialFileOrder(`${getSecretPath()}.mutation`, async () => ({
    secret: await loadSecret(options),
    metadata: await loadMetadata()
  }))
}

async function loadSecret(options: { force?: boolean }): Promise<BitbucketStoredSecret | null> {
  if (cachedSecret !== null) {
    return cachedSecret
  }
  if (!options.force) {
    return null
  }
  const path = getSecretPath()
  if (!(await credentialFileExists(path))) {
    return null
  }
  try {
    const token = readStoredCredentialToken('Bitbucket', await readFile(path))
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

export async function getBitbucketCredentialProtection(): Promise<SecretAtRestProtection | null> {
  return readCredentialFileProtection(getSecretPath())
}

export async function saveBitbucketCredential(input: BitbucketCredentialSaveInput): Promise<void> {
  return inCredentialFileOrder(`${getSecretPath()}.mutation`, async () => {
    await ensureOrcaDir()
    const secret: BitbucketStoredSecret = {
      accessToken: input.accessToken,
      apiToken: input.apiToken,
      authMode: input.authMode,
      email: input.email,
      baseUrl: input.baseUrl
    }
    await writeEncryptedCredential('Bitbucket', getSecretPath(), JSON.stringify(secret))
    const metadata: BitbucketStoredMetadata = {
      version: 1,
      authMode: input.authMode,
      email: input.email,
      baseUrl: input.baseUrl,
      account: input.account,
      updatedAt: new Date().toISOString()
    }
    await writeCredentialFileAtomic(
      getMetadataPath(),
      Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8')
    )
    cachedMetadata = metadata
    metadataLoadedFromDisk = true
    cachedSecret = secret
    credentialError = null
  })
}

// Surface failed deletes so credentials cannot silently reappear on relaunch.
export async function clearStoredBitbucketCredential(): Promise<void> {
  return inCredentialFileOrder(`${getSecretPath()}.mutation`, async () => {
    try {
      for (const path of [getSecretPath(), getMetadataPath()]) {
        try {
          await unlink(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }
    } finally {
      // Clear cached credentials even when deletion only partly succeeds.
      cachedMetadata = null
      metadataLoadedFromDisk = true
      cachedSecret = null
      credentialError = null
    }
  })
}

/** @internal - tests need a clean in-memory cache between cases. */
export function _resetBitbucketCredentialCache(): void {
  cachedMetadata = null
  metadataLoadedFromDisk = false
  cachedSecret = null
  credentialError = null
}
