import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import { validateZaiApiKey } from './zai-api-key-validation'

const ZAI_API_KEY_FILE = 'zai-api-key.enc'
const ZAI_API_KEY_ENVELOPE_PREFIX = 'orca-zai-api-key:v1:'

let cachedZaiApiKey: string | null = null
let warnedZaiApiKeyStatusHardenFailure = false

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getZaiApiKeyPath(): string {
  return join(getOrcaDir(), ZAI_API_KEY_FILE)
}

function encodeEnvelope(payload: Buffer): string {
  return `${ZAI_API_KEY_ENVELOPE_PREFIX}${payload.toString('base64')}`
}

function decodeEnvelope(raw: Buffer): Buffer {
  const text = raw.toString('utf8')
  if (!text.startsWith(ZAI_API_KEY_ENVELOPE_PREFIX)) {
    throw new Error('Z.ai API key could not be decrypted')
  }
  return Buffer.from(text.slice(ZAI_API_KEY_ENVELOPE_PREFIX.length), 'base64')
}

function requireEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Z.ai API key encryption is unavailable on this system')
  }
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('Z.ai API key encryption backend is insecure on this Linux system')
  }
}

export function hasZaiApiKey(): boolean {
  const keyPath = getZaiApiKeyPath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedZaiApiKeyStatusHardenFailure) {
      warnedZaiApiKeyStatusHardenFailure = true
      console.warn('[zai] Failed to harden Z.ai API key file while checking status', error)
    }
  }
  return true
}

export function saveZaiApiKey(apiKey: string): void {
  const trimmed = validateZaiApiKey(apiKey)
  requireEncryptionAvailable()
  writeSecureFile(getZaiApiKeyPath(), encodeEnvelope(safeStorage.encryptString(trimmed)))
  cachedZaiApiKey = trimmed
}

export function readZaiApiKey(): string | null {
  if (cachedZaiApiKey !== null) {
    return cachedZaiApiKey
  }
  const keyPath = getZaiApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[zai] Failed to harden Z.ai API key file while reading', error)
  }
  try {
    requireEncryptionAvailable()
    cachedZaiApiKey = safeStorage.decryptString(decodeEnvelope(readFileSync(keyPath)))
    return cachedZaiApiKey
  } catch (error) {
    console.error('[zai] failed to decode/decrypt API key', error)
    if (
      error instanceof Error &&
      error.message === 'Z.ai API key encryption backend is insecure on this Linux system'
    ) {
      throw error
    }
    throw new Error('Z.ai API key could not be decrypted')
  }
}

export function clearZaiApiKey(): void {
  cachedZaiApiKey = null
  rmSync(getZaiApiKeyPath(), { force: true })
}
