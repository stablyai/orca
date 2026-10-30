import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { getSecretStore } from '../shared/secret-store'
import { fsyncFileSync } from '../shared/secure-file'
import { writeRestrictedWindowsFile } from '../shared/secure-path-windows-acl'
import {
  credentialDecryptionMessage,
  type IntegrationCredentialService
} from '../shared/integration-credential-errors'

// Empty files mean no saved credential; keep status consistent with token reads.
export function credentialFileHasContent(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

// Owner-only plaintext permits connections when the OS keyring is unavailable.
export function writeEncryptedCredential(
  service: IntegrationCredentialService,
  path: string,
  value: string
): void {
  if (getSecretStore().isEncryptionAvailable()) {
    writeCredentialFileAtomic(path, getSecretStore().encryptString(value))
    return
  }
  console.warn(
    `[${service.toLowerCase()}] secret encryption unavailable — storing credential in plaintext`
  )
  writeCredentialFileAtomic(path, Buffer.from(value, 'utf-8'))
}

// Stage and fsync before rename so failed writes cannot truncate the saved credential (STA-3941).
export function writeCredentialFileAtomic(
  path: string,
  data: Buffer,
  shouldPublish?: () => boolean,
  requirePrivateWindowsFile = false
): boolean {
  // Unique temp names prevent concurrent writers from truncating staged bytes.
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let handle: number | null = null
  try {
    if (process.platform === 'win32') {
      // Create owner-only staging files so replacement cannot inherit a permissive Windows DACL.
      const protectedFile = writeRestrictedWindowsFile(tempPath, data, requirePrivateWindowsFile)
      if (requirePrivateWindowsFile && !protectedFile) {
        throw new Error('Private Windows credential-file protection could not be verified.')
      }
      fsyncFileSync(tempPath)
      return publishStagedCredential(tempPath, path, shouldPublish)
    }
    handle = openSync(tempPath, 'w', 0o600)
    // writeSync can return a short count; publish only after all bytes are written.
    let written = 0
    while (written < data.length) {
      const bytes = writeSync(handle, data, written, data.length - written)
      if (bytes <= 0) {
        throw new Error(`Credential write stalled at ${written}/${data.length} bytes`)
      }
      written += bytes
    }
    fsyncSync(handle)
    closeSync(handle)
    handle = null
    return publishStagedCredential(tempPath, path, shouldPublish)
  } catch (error) {
    if (handle !== null) {
      try {
        closeSync(handle)
      } catch {}
    }
    try {
      unlinkSync(tempPath)
    } catch {}
    throw error
  }
}

function publishStagedCredential(
  tempPath: string,
  path: string,
  shouldPublish: (() => boolean) | undefined
): boolean {
  if (shouldPublish && !shouldPublish()) {
    unlinkSync(tempPath)
    return false
  }
  renameSync(tempPath, path)
  restrictCredentialFileToOwner(path)
  return true
}

// Creation mode does not tighten existing files; Windows hardens the staging ACL instead.
export function restrictCredentialFileToOwner(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best-effort hardening; the write itself already succeeded.
  }
}

export class CredentialDecryptionError extends Error {
  constructor(service: IntegrationCredentialService) {
    super(credentialDecryptionMessage(service))
    this.name = 'CredentialDecryptionError'
  }
}

// Undecryptable ciphertext throws CredentialDecryptionError; an empty file returns null.
export function readStoredCredentialToken(
  service: IntegrationCredentialService,
  raw: Buffer
): string | null {
  if (raw.length === 0) {
    return null
  }

  if (getSecretStore().isEncryptionAvailable()) {
    try {
      return usableToken(getSecretStore().decryptString(raw))
    } catch {
      return readPlaintextLegacyCredential(service, raw)
    }
  }

  return readPlaintextLegacyCredential(service, raw)
}

function readPlaintextLegacyCredential(
  service: IntegrationCredentialService,
  raw: Buffer
): string | null {
  const plaintext = decodeUtf8(raw)
  // Legacy plaintext is printable UTF-8; reject ciphertext masquerading as an auth-header value.
  if (plaintext === null || hasControlCharacter(plaintext)) {
    throw new CredentialDecryptionError(service)
  }
  return usableToken(plaintext)
}

function usableToken(token: string): string | null {
  return token.length > 0 ? token : null
}

function decodeUtf8(raw: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return null
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}
