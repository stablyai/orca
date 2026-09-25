import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  hardenExistingSecureFile,
  isUnreadableError,
  writeSecureFile
} from '../../shared/secure-file'
import { ApiKeyFileUnreadableError } from './api-key-file-unreadable-error'

type EncryptedApiKeyFileStore = {
  has: () => boolean
  save: (key: string) => void
  read: () => string | null
  clear: () => void
}

export function createEncryptedApiKeyFileStore({
  fileName,
  envelopePrefix,
  providerLabel,
  logScope
}: {
  fileName: string
  envelopePrefix: string
  providerLabel: string
  logScope: string
}): EncryptedApiKeyFileStore {
  let cachedApiKey: string | null = null
  let warnedStatusHardenFailure = false

  type ApiKeyEnvelope = {
    kind: 'encrypted' | 'plaintext'
    payload: Buffer
  }

  function getOrcaDir(): string {
    return join(homedir(), '.orca')
  }

  function getApiKeyPath(): string {
    return join(getOrcaDir(), fileName)
  }

  function encodeApiKeyEnvelope(kind: ApiKeyEnvelope['kind'], payload: Buffer): string {
    return `${envelopePrefix}${kind}:${payload.toString('base64')}`
  }

  function decodeApiKeyEnvelope(raw: Buffer): ApiKeyEnvelope {
    const text = raw.toString('utf8')
    if (!text.startsWith(envelopePrefix)) {
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
    const rest = text.slice(envelopePrefix.length)
    const separator = rest.indexOf(':')
    if (separator === -1) {
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
    const kind = rest.slice(0, separator)
    if (kind !== 'encrypted' && kind !== 'plaintext') {
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
    return {
      kind,
      payload: Buffer.from(rest.slice(separator + 1), 'base64')
    }
  }

  function readEnvelope(envelope: ApiKeyEnvelope): string {
    if (envelope.kind === 'plaintext') {
      return envelope.payload.toString('utf8')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
    return safeStorage.decryptString(envelope.payload)
  }

  function has(): boolean {
    const keyPath = getApiKeyPath()
    if (!existsSync(keyPath)) {
      return false
    }
    try {
      hardenExistingSecureFile(keyPath)
    } catch (error) {
      if (!warnedStatusHardenFailure) {
        warnedStatusHardenFailure = true
        console.warn(
          `[${logScope}] Failed to harden ${providerLabel} API key file while checking status`,
          error
        )
      }
    }
    return true
  }

  function save(key: string): void {
    const trimmed = key.trim()
    if (!trimmed) {
      throw new Error(`${providerLabel} API key is required`)
    }
    if (safeStorage.isEncryptionAvailable()) {
      writeSecureFile(
        getApiKeyPath(),
        encodeApiKeyEnvelope('encrypted', safeStorage.encryptString(trimmed)),
        { durable: true }
      )
      cachedApiKey = trimmed
      return
    }
    console.warn(
      `[${logScope}] safeStorage encryption unavailable — storing ${providerLabel} API key in plaintext`
    )
    writeSecureFile(
      getApiKeyPath(),
      encodeApiKeyEnvelope('plaintext', Buffer.from(trimmed, 'utf8')),
      { durable: true }
    )
    cachedApiKey = trimmed
  }

  function read(): string | null {
    if (cachedApiKey !== null) {
      return cachedApiKey
    }
    const keyPath = getApiKeyPath()
    if (!existsSync(keyPath)) {
      return null
    }
    // Why: permission failures must not be reported as decryption failures.
    try {
      hardenExistingSecureFile(keyPath)
    } catch (error) {
      console.warn(
        `[${logScope}] Failed to harden ${providerLabel} API key file while reading`,
        error
      )
    }
    let raw: Buffer | null = null
    try {
      raw = readFileSync(keyPath)
      const envelope = decodeApiKeyEnvelope(raw)
      cachedApiKey = readEnvelope(envelope)
      return cachedApiKey
    } catch (error) {
      if (raw === null && isUnreadableError(error)) {
        console.warn(`[${logScope}] failed to read API key file`, error)
        throw new ApiKeyFileUnreadableError(`${providerLabel} API key file could not be read`)
      }
      console.error(`[${logScope}] failed to decode/decrypt API key`, error)
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
  }

  function clear(): void {
    cachedApiKey = null
    rmSync(getApiKeyPath(), { force: true })
  }

  return { has, save, read, clear }
}
