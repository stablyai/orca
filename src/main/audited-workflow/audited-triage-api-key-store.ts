// Encrypted local storage for the Audited Workflow triage OpenAI API key.
// Mirrors src/main/speech/openai-api-key-store.ts's safeStorage-backed
// pattern exactly, kept as a separate file/key so the two features' secrets
// are never conflated (a user may configure one without the other).
import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TRIAGE_TOKEN_FILE = 'audited-workflow-triage-openai-token.enc'
let cachedTriageApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getTriageKeyPath(): string {
  return join(getOrcaDir(), TRIAGE_TOKEN_FILE)
}

export function hasAuditedTriageApiKey(): boolean {
  return existsSync(getTriageKeyPath())
}

export function saveAuditedTriageApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('OpenAI API key is required')
  }
  ensureOrcaDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getTriageKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    cachedTriageApiKey = trimmed
    return
  }

  console.warn(
    '[auditedWorkflow] safeStorage encryption unavailable — storing triage OpenAI key in plaintext'
  )
  writeFileSync(getTriageKeyPath(), trimmed, { encoding: 'utf8', mode: 0o600 })
  cachedTriageApiKey = trimmed
}

export function readAuditedTriageApiKey(): string {
  if (cachedTriageApiKey !== null) {
    return cachedTriageApiKey
  }

  const keyPath = getTriageKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('Audited Workflow triage OpenAI API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    cachedTriageApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedTriageApiKey
  } catch {
    throw new Error('Audited Workflow triage OpenAI API key could not be decrypted')
  }
}

export function clearAuditedTriageApiKey(): void {
  cachedTriageApiKey = null
  rmSync(getTriageKeyPath(), { force: true })
}
