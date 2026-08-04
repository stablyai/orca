import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MemorySnapshot, SnapshotAvailability } from '../../shared/memory-snapshot'
import { readSnapshotFileThroughFilesystemHost } from '../filesystem-host/filesystem-host-read-authority'

type StoredOpenAiKey = {
  encryptedKeyBase64: string
}

const OPENAI_SPEECH_TOKEN_FILE = 'openai-speech-token.enc'
let cachedOpenAiSpeechApiKey: string | null = null
let apiKeyStatusGeneration = 0
let apiKeyStatusObservedAt: number | null = null
let apiKeyStatusValue = false
let apiKeyStatusAvailability: SnapshotAvailability = 'unavailable'
let apiKeyStatusStale = true
let apiKeyStatusHydration: Promise<MemorySnapshot<boolean>> | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getOpenAiKeyPath(): string {
  return join(getOrcaDir(), OPENAI_SPEECH_TOKEN_FILE)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function publishApiKeyStatus(configured: boolean, availability: SnapshotAvailability): void {
  apiKeyStatusValue = configured
  apiKeyStatusAvailability = availability
  apiKeyStatusObservedAt = Date.now()
  apiKeyStatusStale = false
}

function markApiKeyStatusUnavailable(): void {
  apiKeyStatusAvailability = 'unavailable'
  apiKeyStatusStale = true
}

export function getOpenAiSpeechApiKeySnapshot(): MemorySnapshot<boolean> {
  return {
    value: apiKeyStatusValue,
    stale: apiKeyStatusStale,
    age: apiKeyStatusObservedAt === null ? null : Math.max(0, Date.now() - apiKeyStatusObservedAt),
    availability: apiKeyStatusAvailability
  }
}

export async function hydrateOpenAiSpeechApiKeySnapshot(): Promise<MemorySnapshot<boolean>> {
  if (apiKeyStatusHydration) {
    return await apiKeyStatusHydration
  }
  const hydration = hydrateOpenAiSpeechApiKeySnapshotNow().finally(() => {
    if (apiKeyStatusHydration === hydration) {
      apiKeyStatusHydration = null
    }
  })
  apiKeyStatusHydration = hydration
  return await hydration
}

async function hydrateOpenAiSpeechApiKeySnapshotNow(): Promise<MemorySnapshot<boolean>> {
  const generation = apiKeyStatusGeneration
  try {
    await readSnapshotFileThroughFilesystemHost(getOpenAiKeyPath(), 'openai-speech-key')
    if (generation === apiKeyStatusGeneration) {
      publishApiKeyStatus(true, 'ready')
    }
  } catch (error) {
    if (generation === apiKeyStatusGeneration) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        publishApiKeyStatus(false, 'missing')
      } else {
        apiKeyStatusAvailability = code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unavailable'
        apiKeyStatusStale = true
      }
    }
  }
  return getOpenAiSpeechApiKeySnapshot()
}

function readLegacyJsonStoredOpenAiKey(): StoredOpenAiKey | null {
  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as Partial<StoredOpenAiKey>
    if (typeof parsed.encryptedKeyBase64 !== 'string' || parsed.encryptedKeyBase64 === '') {
      return null
    }
    return { encryptedKeyBase64: parsed.encryptedKeyBase64 }
  } catch {
    return null
  }
}

export function hasOpenAiSpeechApiKey(): boolean {
  return getOpenAiSpeechApiKeySnapshot().value === true
}

export function saveOpenAiSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('OpenAI API key is required')
  }
  apiKeyStatusGeneration += 1
  let contents: Buffer
  if (safeStorage.isEncryptionAvailable()) {
    contents = safeStorage.encryptString(trimmed)
  } else {
    console.warn(
      '[speech] safeStorage encryption unavailable — storing OpenAI speech key in plaintext'
    )
    contents = Buffer.from(trimmed, 'utf8')
  }
  try {
    ensureOrcaDir()
    writeFileSync(getOpenAiKeyPath(), contents, { mode: 0o600 })
    cachedOpenAiSpeechApiKey = trimmed
    publishApiKeyStatus(true, 'ready')
  } catch (error) {
    markApiKeyStatusUnavailable()
    throw error
  }
}

export function readOpenAiSpeechApiKey(): string {
  if (cachedOpenAiSpeechApiKey !== null) {
    return cachedOpenAiSpeechApiKey
  }

  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('OpenAI API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    const legacyJson = readLegacyJsonStoredOpenAiKey()
    if (legacyJson) {
      cachedOpenAiSpeechApiKey = safeStorage.decryptString(
        Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
      )
      publishApiKeyStatus(true, 'ready')
      return cachedOpenAiSpeechApiKey
    }
    cachedOpenAiSpeechApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    publishApiKeyStatus(true, 'ready')
    return cachedOpenAiSpeechApiKey
  } catch {
    throw new Error('OpenAI API key could not be decrypted')
  }
}

export function clearOpenAiSpeechApiKey(): void {
  try {
    rmSync(getOpenAiKeyPath(), { force: true })
  } catch (error) {
    markApiKeyStatusUnavailable()
    throw error
  }
  apiKeyStatusGeneration += 1
  cachedOpenAiSpeechApiKey = null
  publishApiKeyStatus(false, 'missing')
}
