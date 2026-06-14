import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const ZAI_API_KEY_FILE = 'zai-api-key.enc'
const PLAINTEXT_WARNING =
  '[zai-api-key] safeStorage encryption unavailable — storing Z.AI API key in plaintext'

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getZaiApiKeyPath(): string {
  return join(getOrcaDir(), ZAI_API_KEY_FILE)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function hasZaiApiKey(): boolean {
  return existsSync(getZaiApiKeyPath())
}

export function readZaiApiKey(): string | null {
  const keyPath = getZaiApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const raw = readFileSync(keyPath)
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
  } catch {
    return null
  }
}

export function saveZaiApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Z.AI API key is required')
  }
  ensureOrcaDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getZaiApiKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    return
  }

  console.warn(PLAINTEXT_WARNING)
  writeFileSync(getZaiApiKeyPath(), trimmed, { encoding: 'utf8', mode: 0o600 })
}

export function clearZaiApiKey(): void {
  rmSync(getZaiApiKeyPath(), { force: true })
}
