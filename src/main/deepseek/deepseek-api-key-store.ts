import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'

// Mirrors minimax-cookie-store: a safeStorage-encrypted file with an envelope so
// the encryption mode is self-describing and plaintext fallback is explicit.
const DEEPSEEK_API_KEY_FILE = 'deepseek-api-key.enc'
const ENVELOPE_PREFIX = 'orca-deepseek-api-key:v1:'
let cachedApiKey: string | null = null
let warnedStatusHardenFailure = false

type Envelope = { kind: 'encrypted' | 'plaintext'; payload: Buffer }

function getKeyPath(): string {
  return join(homedir(), '.orca', DEEPSEEK_API_KEY_FILE)
}

function encodeEnvelope(kind: Envelope['kind'], payload: Buffer): string {
  return `${ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeEnvelope(raw: Buffer): Envelope {
  const text = raw.toString('utf8')
  if (!text.startsWith(ENVELOPE_PREFIX)) {
    throw new Error('DeepSeek API key could not be decrypted')
  }
  const rest = text.slice(ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  const kind = separator < 0 ? '' : rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('DeepSeek API key could not be decrypted')
  }
  return { kind, payload: Buffer.from(rest.slice(separator + 1), 'base64') }
}

function readEnvelope(envelope: Envelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('DeepSeek API key could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

export function hasDeepSeekApiKey(): boolean {
  const keyPath = getKeyPath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedStatusHardenFailure) {
      warnedStatusHardenFailure = true
      console.warn('[deepseek] Failed to harden API key file while checking status', error)
    }
  }
  return true
}

export function saveDeepSeekApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('DeepSeek API key is required')
  }
  if (safeStorage.isEncryptionAvailable()) {
    writeSecureFile(getKeyPath(), encodeEnvelope('encrypted', safeStorage.encryptString(trimmed)))
  } else {
    console.warn('[deepseek] safeStorage encryption unavailable — storing API key in plaintext')
    writeSecureFile(getKeyPath(), encodeEnvelope('plaintext', Buffer.from(trimmed, 'utf8')))
  }
  cachedApiKey = trimmed
}

export function readStoredDeepSeekApiKey(): string | null {
  if (cachedApiKey !== null) {
    return cachedApiKey
  }
  const keyPath = getKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  // Keep hardening out of the decode/decrypt try so a chmod/ACL failure isn't
  // misreported as a decrypt failure (matches hasDeepSeekApiKey).
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[deepseek] Failed to harden API key file while reading', error)
  }
  try {
    cachedApiKey = readEnvelope(decodeEnvelope(readFileSync(keyPath)))
    return cachedApiKey
  } catch (error) {
    console.error('[deepseek] failed to decode/decrypt API key', error)
    throw new Error('DeepSeek API key could not be decrypted')
  }
}

export function clearDeepSeekApiKey(): void {
  cachedApiKey = null
  rmSync(getKeyPath(), { force: true })
}

// Testing seam: the module-level cache would otherwise leak across unit tests.
export function resetDeepSeekApiKeyCacheForTests(): void {
  cachedApiKey = null
}
