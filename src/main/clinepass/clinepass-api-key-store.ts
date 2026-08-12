import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClinePassCredentialsStatus } from '../../shared/clinepass-credentials'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'

const CLINEPASS_API_KEY_FILE = 'clinepass-api-key.enc'
const API_KEY_ENVELOPE_PREFIX = 'orca-clinepass-api-key:v1:encrypted:'
const CLINE_API_KEY_ENV = 'CLINE_API_KEY'
const SECURE_STORAGE_UNAVAILABLE_ERROR =
  'ClinePass API key cannot be stored securely on this system. Set the CLINE_API_KEY environment variable instead.'

let cachedClinePassApiKey: string | null = null
let warnedClinePassStatusHardenFailure = false

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getClinePassApiKeyPath(): string {
  return join(getOrcaDir(), CLINEPASS_API_KEY_FILE)
}

function isClinePassSecureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) {
    return false
  }
  // Why: Electron's Linux basic_text backend only obscures bytes; treat it as
  // unavailable so we never persist a recoverable API key to disk.
  if (process.platform === 'linux') {
    const backend =
      typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend()
        : null
    if (backend === 'basic_text') {
      return false
    }
  }
  return true
}

function encodeEncryptedApiKeyEnvelope(encrypted: Buffer): string {
  return `${API_KEY_ENVELOPE_PREFIX}${encrypted.toString('base64')}`
}

function decodeEncryptedApiKeyEnvelope(raw: Buffer): Buffer {
  const text = raw.toString('utf8')
  if (!text.startsWith(API_KEY_ENVELOPE_PREFIX)) {
    throw new Error('ClinePass API key could not be decrypted')
  }
  const payload = Buffer.from(text.slice(API_KEY_ENVELOPE_PREFIX.length), 'base64')
  if (payload.length === 0) {
    throw new Error('ClinePass API key could not be decrypted')
  }
  return payload
}

function readEnvironmentClinePassApiKey(): string | null {
  const value = process.env[CLINE_API_KEY_ENV]?.trim()
  return value ? value : null
}

function hasStoredClinePassApiKey(): boolean {
  const keyPath = getClinePassApiKeyPath()
  if (!existsSync(keyPath)) {
    return false
  }
  // Why: Settings/status polls should not decrypt (and prompt the keychain) just to know a key is on disk.
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedClinePassStatusHardenFailure) {
      warnedClinePassStatusHardenFailure = true
      console.warn(
        '[clinepass] Failed to harden ClinePass API key file while checking status',
        error
      )
    }
  }
  return true
}

function readStoredClinePassApiKey(): string | null {
  if (cachedClinePassApiKey !== null) {
    return cachedClinePassApiKey
  }
  const keyPath = getClinePassApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  // Why: keep hardening out of the decode/decrypt try so a chmod/ACL failure
  // isn't misreported as a decrypt failure (matches hasStoredClinePassApiKey).
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[clinepass] Failed to harden ClinePass API key file while reading', error)
  }
  if (!isClinePassSecureStorageAvailable()) {
    throw new Error('ClinePass API key could not be decrypted')
  }
  try {
    const encrypted = decodeEncryptedApiKeyEnvelope(readFileSync(keyPath))
    const value = safeStorage.decryptString(encrypted).trim()
    if (!value) {
      throw new Error('ClinePass API key could not be decrypted')
    }
    cachedClinePassApiKey = value
    return cachedClinePassApiKey
  } catch (error) {
    console.error('[clinepass] failed to decode/decrypt API key', error)
    throw new Error('ClinePass API key could not be decrypted')
  }
}

export function hasClinePassApiKey(): boolean {
  return hasStoredClinePassApiKey() || readEnvironmentClinePassApiKey() !== null
}

export function getClinePassCredentialsStatus(): ClinePassCredentialsStatus {
  if (hasStoredClinePassApiKey()) {
    return { configured: true, source: 'stored' }
  }
  if (readEnvironmentClinePassApiKey() !== null) {
    return { configured: true, source: 'environment' }
  }
  return { configured: false, source: 'none' }
}

export function saveClinePassApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('ClinePass API key is required')
  }
  if (!isClinePassSecureStorageAvailable()) {
    throw new Error(SECURE_STORAGE_UNAVAILABLE_ERROR)
  }
  writeSecureFile(
    getClinePassApiKeyPath(),
    encodeEncryptedApiKeyEnvelope(safeStorage.encryptString(trimmed))
  )
  cachedClinePassApiKey = trimmed
}

/** Prefer the securely stored key; fall back to official `CLINE_API_KEY`. Never returns the key over IPC. */
export function readClinePassApiKey(): string | null {
  const stored = readStoredClinePassApiKey()
  if (stored) {
    return stored
  }
  return readEnvironmentClinePassApiKey()
}

export function clearClinePassApiKey(): void {
  cachedClinePassApiKey = null
  rmSync(getClinePassApiKeyPath(), { force: true })
}
