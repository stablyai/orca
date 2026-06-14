import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const ZAI_API_KEY_FILE = 'zai-api-key.enc'
const PLAINTEXT_WARNING =
  '[zai-api-key] safeStorage encryption unavailable — storing Z.AI API key in plaintext'

type StoredZaiApiKeyRecord =
  | { v: 1; mode: 'encrypted'; payload: string }
  | { v: 1; mode: 'plaintext'; payload: string }

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
    return readStoredZaiApiKey(raw)
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
    writeStoredZaiApiKey({
      v: 1,
      mode: 'encrypted',
      payload: safeStorage.encryptString(trimmed).toString('base64')
    })
    return
  }

  console.warn(PLAINTEXT_WARNING)
  writeStoredZaiApiKey({ v: 1, mode: 'plaintext', payload: trimmed })
}

export function clearZaiApiKey(): void {
  rmSync(getZaiApiKeyPath(), { force: true })
}

function writeStoredZaiApiKey(record: StoredZaiApiKeyRecord): void {
  // Why: the file survives across machines/sessions where safeStorage
  // availability can change, so the on-disk mode must be explicit.
  writeFileSync(getZaiApiKeyPath(), JSON.stringify(record), {
    encoding: 'utf8',
    mode: 0o600
  })
}

function readStoredZaiApiKey(raw: Buffer): string | null {
  const record = parseStoredZaiApiKeyRecord(raw)
  if (!record) {
    return readLegacyStoredZaiApiKey(raw)
  }

  if (record.mode === 'plaintext') {
    return record.payload
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return null
  }

  try {
    return safeStorage.decryptString(Buffer.from(record.payload, 'base64'))
  } catch {
    return null
  }
}

function parseStoredZaiApiKeyRecord(raw: Buffer): StoredZaiApiKeyRecord | null {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<StoredZaiApiKeyRecord>
    if (
      parsed?.v === 1 &&
      typeof parsed.payload === 'string' &&
      (parsed.mode === 'encrypted' || parsed.mode === 'plaintext')
    ) {
      return parsed as StoredZaiApiKeyRecord
    }
  } catch {
    return null
  }

  return null
}

function readLegacyStoredZaiApiKey(raw: Buffer): string | null {
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
  } catch {
    return null
  }
}
