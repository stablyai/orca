import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { readFile, rm } from 'node:fs/promises'
import {
  credentialFileExists,
  hardenCredentialFile,
  inCredentialFileOrder,
  stageCredentialFile
} from './credential-file-io'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isUnreadableError } from '../../shared/secure-storage/secure-file'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import { ApiKeyFileUnreadableError } from './api-key-file-unreadable-error'

type EncryptedApiKeyFileStore = {
  /** Envelope location and prefix used by orcad's plaintext migration. */
  envelopeFile: () => { path: string; envelopePrefix: string }
  protection: () => Promise<SecretAtRestProtection | null>
  has: () => Promise<boolean>
  save: (key: string) => Promise<void>
  read: () => Promise<string | null>
  clear: () => Promise<void>
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
    if (!getSecretStore().isEncryptionAvailable()) {
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
    return getSecretStore().decryptString(envelope.payload)
  }

  async function has(): Promise<boolean> {
    const keyPath = getApiKeyPath()
    if (!(await credentialFileExists(keyPath))) {
      return false
    }
    try {
      await hardenCredentialFile(keyPath)
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

  async function protection(): Promise<SecretAtRestProtection | null> {
    const path = getApiKeyPath()
    if (!(await credentialFileExists(path))) {
      return null
    }
    try {
      const envelope = decodeApiKeyEnvelope(await readFile(path))
      return envelope.kind === 'plaintext' ? 'plaintext' : 'sealed'
    } catch {
      return null
    }
  }

  async function save(key: string): Promise<void> {
    const trimmed = key.trim()
    if (!trimmed) {
      throw new Error(`${providerLabel} API key is required`)
    }
    if (getSecretStore().isEncryptionAvailable()) {
      await stageCredentialFile(
        getApiKeyPath(),
        encodeApiKeyEnvelope('encrypted', getSecretStore().encryptString(trimmed)),
        { durable: true, createDirectory: true }
      )
      cachedApiKey = trimmed
      return
    }
    console.warn(
      `[${logScope}] safeStorage encryption unavailable — storing ${providerLabel} API key in plaintext`
    )
    await stageCredentialFile(
      getApiKeyPath(),
      encodeApiKeyEnvelope('plaintext', Buffer.from(trimmed, 'utf8')),
      { durable: true, createDirectory: true }
    )
    cachedApiKey = trimmed
  }

  async function read(): Promise<string | null> {
    if (cachedApiKey !== null) {
      return cachedApiKey
    }
    const keyPath = getApiKeyPath()
    if (!(await credentialFileExists(keyPath))) {
      return null
    }
    // Keep permission failures distinct from decryption failures.
    try {
      await hardenCredentialFile(keyPath)
    } catch (error) {
      console.warn(
        `[${logScope}] Failed to harden ${providerLabel} API key file while reading`,
        error
      )
    }
    let raw: Buffer | null = null
    try {
      raw = await readFile(keyPath)
      const envelope = decodeApiKeyEnvelope(raw)
      cachedApiKey = readEnvelope(envelope)
      return cachedApiKey
    } catch (error) {
      if (raw === null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      if (raw === null && isUnreadableError(error)) {
        console.warn(`[${logScope}] failed to read API key file`, error)
        throw new ApiKeyFileUnreadableError(`${providerLabel} API key file could not be read`)
      }
      console.error(`[${logScope}] failed to decode/decrypt API key`, error)
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
  }

  async function clear(): Promise<void> {
    cachedApiKey = null
    await rm(getApiKeyPath(), { force: true })
  }

  return {
    has: () => inCredentialFileOrder(getApiKeyPath(), has),
    save: (key) => inCredentialFileOrder(getApiKeyPath(), () => save(key)),
    read: () => inCredentialFileOrder(getApiKeyPath(), read),
    clear: () => inCredentialFileOrder(getApiKeyPath(), clear),
    protection: () => inCredentialFileOrder(getApiKeyPath(), protection),
    envelopeFile: () => ({ path: getApiKeyPath(), envelopePrefix })
  }
}
