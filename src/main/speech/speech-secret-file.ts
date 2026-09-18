import { getSecretStore } from '../../shared/secret-store'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Why: every cloud speech provider stores exactly one API key as a single blob under ~/.orca.
 * Sharing read/write/clear keeps the at-rest contract identical across providers — Electron
 * safeStorage when available, plaintext with a warning when it is not, mode 0o600 — so adding a
 * provider cannot quietly weaken (or duplicate) the encryption path.
 */
export function getSpeechSecretFilePath(fileName: string): string {
  return join(homedir(), '.orca', fileName)
}

export function hasStoredSpeechSecret(fileName: string): boolean {
  // Why: settings and model-state refresh call this on startup; checking file existence avoids
  // a decrypt that triggers macOS keychain prompts.
  return existsSync(getSpeechSecretFilePath(fileName))
}

export function readStoredSpeechSecret(fileName: string, providerLabel: string): string {
  const filePath = getSpeechSecretFilePath(fileName)
  if (!existsSync(filePath)) {
    throw new Error(`${providerLabel} API key is not configured`)
  }
  try {
    const raw = readFileSync(filePath)
    return getSecretStore().isEncryptionAvailable()
      ? getSecretStore().decryptString(raw)
      : raw.toString('utf8')
  } catch {
    throw new Error(`${providerLabel} API key could not be decrypted`)
  }
}

export function writeStoredSpeechSecret(
  fileName: string,
  apiKey: string,
  providerLabel: string
): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error(`${providerLabel} API key is required`)
  }
  const filePath = getSpeechSecretFilePath(fileName)
  mkdirSync(dirname(filePath), { recursive: true })
  if (getSecretStore().isEncryptionAvailable()) {
    writeFileSync(filePath, getSecretStore().encryptString(trimmed), { mode: 0o600 })
    return
  }

  console.warn(
    `[speech] secret encryption unavailable — storing ${providerLabel} speech key in plaintext`
  )
  writeFileSync(filePath, trimmed, { encoding: 'utf8', mode: 0o600 })
}

export function clearStoredSpeechSecret(fileName: string): void {
  rmSync(getSpeechSecretFilePath(fileName), { force: true })
}
