import { chmod, stat } from 'node:fs/promises'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { inCredentialFileOrder, stageCredentialFile } from './credential-file-io'
import {
  credentialDecryptionMessage,
  type IntegrationCredentialService
} from '../../shared/secure-storage/integration-credential-errors'

// Empty files mean no saved credential; keep status consistent with token reads.
export async function credentialFileHasContent(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

// Owner-only plaintext permits connections when the OS keyring is unavailable.
export async function writeEncryptedCredential(
  service: IntegrationCredentialService,
  path: string,
  value: string
): Promise<void> {
  if (getSecretStore().isEncryptionAvailable()) {
    await writeCredentialFileAtomic(path, getSecretStore().encryptString(value))
    return
  }
  console.warn(
    `[${service.toLowerCase()}] secret encryption unavailable — storing credential in plaintext`
  )
  await writeCredentialFileAtomic(path, Buffer.from(value, 'utf-8'))
}

export function writeCredentialFileAtomic(
  path: string,
  data: Buffer,
  shouldPublish?: () => boolean,
  requirePrivateWindowsFile = false
): Promise<boolean> {
  return inCredentialFileOrder(path, async () => {
    let published = false
    await stageCredentialFile(path, data, {
      syncFile: true,
      shouldPublish: () => (published = shouldPublish?.() ?? true),
      requirePrivateWindowsFile
    })
    return published
  })
}

export async function restrictCredentialFileToOwner(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch {}
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
