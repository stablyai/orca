import { getSecretStore } from '../../shared/secret-store'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

const OLLAMA_CLOUD_API_KEY_FILE = 'ollama-cloud-api-key.enc'
export const OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX = 'orca-ollama-cloud-api-key:v1:'
let cachedOllamaCloudApiKey: string | null = null
let warnedOllamaCloudApiKeyStatusHardenFailure = false

type OllamaCloudApiKeyEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

export function getOllamaCloudApiKeyPath(): string {
  return join(homedir(), '.orca', OLLAMA_CLOUD_API_KEY_FILE)
}

function encodeApiKeyEnvelope(kind: OllamaCloudApiKeyEnvelope['kind'], payload: Buffer): string {
  return `${OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeApiKeyEnvelope(raw: Buffer): OllamaCloudApiKeyEnvelope {
  const text = raw.toString('utf8')
  if (!text.startsWith(OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX)) {
    throw new Error('Ollama cloud API key could not be decrypted')
  }
  const rest = text.slice(OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator === -1) {
    throw new Error('Ollama cloud API key could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('Ollama cloud API key could not be decrypted')
  }
  return {
    kind,
    payload: Buffer.from(rest.slice(separator + 1), 'base64')
  }
}

function readEnvelope(envelope: OllamaCloudApiKeyEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!getSecretStore().isEncryptionAvailable()) {
    throw new Error('Ollama cloud API key could not be decrypted')
  }
  return getSecretStore().decryptString(envelope.payload)
}

export function hasOllamaCloudApiKey(): boolean {
  const keyPath = getOllamaCloudApiKeyPath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedOllamaCloudApiKeyStatusHardenFailure) {
      warnedOllamaCloudApiKeyStatusHardenFailure = true
      console.warn(
        '[ollama] Failed to harden Ollama cloud API key file while checking status',
        error
      )
    }
  }
  return true
}

export function getOllamaCloudApiKeyProtection(): SecretAtRestProtection | null {
  const keyPath = getOllamaCloudApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    return decodeApiKeyEnvelope(readFileSync(keyPath)).kind === 'plaintext' ? 'plaintext' : 'sealed'
  } catch {
    return null
  }
}

function rollbackPlaintextEnvelope(
  keyPath: string,
  attemptedEnvelope: string,
  previousEnvelope: Buffer | null
): void {
  const attempted = Buffer.from(attemptedEnvelope, 'utf8')
  try {
    if (!readFileSync(keyPath).equals(attempted)) {
      return
    }
    if (previousEnvelope) {
      try {
        writeSecureFile(keyPath, previousEnvelope.toString('utf8'), {
          shouldPublish: () => readFileSync(keyPath).equals(attempted)
        })
      } catch {
        // A failed restore may already have published the previous envelope.
      }
    }
    const currentEnvelope = readFileSync(keyPath)
    if (
      currentEnvelope.equals(attempted) &&
      (!previousEnvelope || !currentEnvelope.equals(previousEnvelope))
    ) {
      rmSync(keyPath, { force: true })
    }
  } catch {
    // Unreadable current bytes do not establish ownership of the rejected write.
  }
}

export function saveOllamaCloudApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) {
    throw new Error('Ollama cloud API key is required')
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('Ollama cloud API key must be a single line')
  }
  if (getSecretStore().isEncryptionAvailable()) {
    writeSecureFile(
      getOllamaCloudApiKeyPath(),
      encodeApiKeyEnvelope('encrypted', getSecretStore().encryptString(trimmed))
    )
    cachedOllamaCloudApiKey = trimmed
    return
  }
  console.warn(
    '[ollama] safeStorage encryption unavailable — storing Ollama cloud API key in plaintext'
  )
  const keyPath = getOllamaCloudApiKeyPath()
  // Capture old bytes before secure publication can replace them yet report restriction failure; rollback must preserve the working key.
  let previousEnvelope: Buffer | null = null
  if (existsSync(keyPath)) {
    try {
      previousEnvelope = readFileSync(keyPath)
    } catch {
      previousEnvelope = null
    }
  }
  const attemptedEnvelope = encodeApiKeyEnvelope('plaintext', Buffer.from(trimmed, 'utf8'))
  const wroteRestricted = writeSecureFile(keyPath, attemptedEnvelope)
  // Unrestricted plaintext must never be acknowledged as saved.
  if (!wroteRestricted) {
    rollbackPlaintextEnvelope(keyPath, attemptedEnvelope, previousEnvelope)
    throw new Error('Ollama cloud API key could not be stored securely on this device')
  }
  cachedOllamaCloudApiKey = trimmed
}

export function readOllamaCloudApiKey(): string | null {
  if (cachedOllamaCloudApiKey !== null) {
    return cachedOllamaCloudApiKey
  }
  const keyPath = getOllamaCloudApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  // Separate hardening from decryption so ACL/chmod faults cannot masquerade as decrypt failures.
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[ollama] Failed to harden Ollama cloud API key file while reading', error)
  }
  try {
    const raw = readFileSync(keyPath)
    const envelope = decodeApiKeyEnvelope(raw)
    cachedOllamaCloudApiKey = readEnvelope(envelope)
    return cachedOllamaCloudApiKey
  } catch (error) {
    console.error('[ollama] failed to decode/decrypt Ollama cloud API key', error)
    throw new Error('Ollama cloud API key could not be decrypted')
  }
}

export function clearOllamaCloudApiKey(): void {
  cachedOllamaCloudApiKey = null
  rmSync(getOllamaCloudApiKeyPath(), { force: true })
}
