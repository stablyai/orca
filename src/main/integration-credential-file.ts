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

// Why: connection status treats a token file as a saved credential; empty
// files read as "missing", so counting them would split-brain getStatus.
export function credentialFileHasContent(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

// Falls back to 0600 plaintext when the OS keyring is unavailable, matching the
// Linear/Jira token writers so a keyring-less box still connects.
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

// Why (STA-3941): a direct write can truncate the previous credential if it
// fails or the app dies mid-write, leaving nothing to authenticate with. Write
// a sibling temp file, fsync it, then rename — readers only ever observe the
// old bytes or the complete new ones.
export function writeCredentialFileAtomic(
  path: string,
  data: Buffer,
  shouldPublish?: () => boolean
): boolean {
  // Why unique: a concurrent writer sharing one temp name could truncate the bytes we publish.
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let handle: number | null = null
  try {
    if (process.platform === 'win32') {
      // Why born restricted: a sibling would otherwise inherit the directory's DACL and replace
      // the previous credential's owner-only ACL.
      writeRestrictedWindowsFile(tempPath, data)
      fsyncFileSync(tempPath)
      return publishStagedCredential(tempPath, path, shouldPublish)
    }
    handle = openSync(tempPath, 'w', 0o600)
    // Why: write(2) is allowed to return a short count, so a single writeSync
    // could publish a truncated credential — the very corruption this avoids.
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
      } catch {
        // Already closed or invalid; the unlink below is what matters.
      }
    }
    try {
      unlinkSync(tempPath)
    } catch {
      // Nothing to clean up.
    }
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

// Why: writeFileSync's `mode` only applies when it creates the file, so
// rewriting an existing credential would silently keep looser permissions.
// Best-effort: Windows has no POSIX modes; its staging file is created owner-only instead.
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

// Returns the stored token, null when the file is empty, and throws
// CredentialDecryptionError when the file holds ciphertext we cannot decrypt
// (e.g. the user denied the OS keychain prompt after an app re-sign).
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
  // Why: legacy plaintext tokens are printable UTF-8; sealed ciphertext
  // such as macOS v10 blobs must not be decoded into auth-header junk.
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
