import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'

function keyPath(): string {
  return join(homedir(), '.orca', 'elevenlabs-speech-token.enc')
}

export function hasElevenLabsSpeechApiKey(): boolean {
  return existsSync(keyPath())
}

export function saveElevenLabsSpeechApiKey(value: unknown): void {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(value.trim())) {
    throw new Error('elevenlabs_invalid_key')
  }
  const store = getSecretStore()
  if (!store.isEncryptionAvailable() || store.describeProtectionGap() !== null) {
    throw new Error('elevenlabs_encryption_unavailable')
  }
  try {
    const encrypted = store.encryptString(value.trim())
    mkdirSync(join(homedir(), '.orca'), { recursive: true })
    writeFileSync(keyPath(), encrypted, { mode: 0o600 })
  } catch {
    throw new Error('elevenlabs_key_save_failed')
  }
}

export function readElevenLabsSpeechApiKey(): string {
  try {
    return getSecretStore().decryptString(readFileSync(keyPath()))
  } catch {
    throw new Error('elevenlabs_key_unavailable')
  }
}

export function canReadElevenLabsSpeechApiKey(): boolean {
  if (!hasElevenLabsSpeechApiKey()) {
    return false
  }
  try {
    return Boolean(readElevenLabsSpeechApiKey())
  } catch {
    return false
  }
}

export function clearElevenLabsSpeechApiKey(): void {
  try {
    rmSync(keyPath(), { force: true })
  } catch {
    throw new Error('elevenlabs_key_clear_failed')
  }
}
