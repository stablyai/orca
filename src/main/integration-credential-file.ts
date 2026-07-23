import { statSync } from 'node:fs'
import { safeStorage } from 'electron'
import {
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from '../shared/node-bounded-file-reader'
import {
  credentialDecryptionMessage,
  type IntegrationCredentialService
} from '../shared/integration-credential-errors'

export const MAX_INTEGRATION_CREDENTIAL_FILE_BYTES = 1024 * 1024

export function readIntegrationCredentialFileSync(filePath: string): Buffer {
  return readNodeFileSyncWithinLimit(filePath, MAX_INTEGRATION_CREDENTIAL_FILE_BYTES).buffer
}

export function readIntegrationCredentialFileSyncText(filePath: string): string {
  return readIntegrationCredentialFileSync(filePath).toString('utf8')
}

export async function readIntegrationCredentialFileText(filePath: string): Promise<string> {
  return (
    await readNodeFileWithinLimit(filePath, MAX_INTEGRATION_CREDENTIAL_FILE_BYTES)
  ).buffer.toString('utf8')
}

// Why: connection status treats a token file as a saved credential; empty
// files read as "missing", so counting them would split-brain getStatus.
export function credentialFileHasContent(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
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

  if (safeStorage.isEncryptionAvailable()) {
    try {
      return usableToken(safeStorage.decryptString(raw))
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
  // Why: legacy plaintext tokens are printable UTF-8; safeStorage ciphertext
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
