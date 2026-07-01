import { safeStorage } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type StoredSarvamKey = {
  encryptedKeyBase64: string
}

const SARVAM_SPEECH_TOKEN_FILE = 'sarvam-speech-token.enc'
// Why: the on-disk file must say how it was written so that after a restart the
// read path never has to guess plaintext vs. ciphertext (guessing decrypts
// plaintext as garbage, or returns ciphertext as text, once safeStorage
// availability changes between save and read).
const ENCRYPTED_ENVELOPE_MARKER = Buffer.from('sarvam-key:v1:enc\n', 'utf8')
const PLAINTEXT_ENVELOPE_MARKER = Buffer.from('sarvam-key:v1:raw\n', 'utf8')
let cachedSarvamSpeechApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getSarvamKeyPath(): string {
  return join(getOrcaDir(), SARVAM_SPEECH_TOKEN_FILE)
}

function startsWithMarker(raw: Buffer, marker: Buffer): boolean {
  return raw.length >= marker.length && raw.subarray(0, marker.length).equals(marker)
}

function writeSarvamKeyFile(contents: Buffer): void {
  const keyPath = getSarvamKeyPath()
  writeFileSync(keyPath, contents, { mode: 0o600 })
  // Why: the `mode` option only applies when creating a new file; overwriting an
  // existing (possibly world-readable) key file keeps its old permissions, so
  // restrict it explicitly on every write.
  chmodSync(keyPath, 0o600)
}

function readLegacyJsonStoredSarvamKey(): StoredSarvamKey | null {
  const keyPath = getSarvamKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as Partial<StoredSarvamKey>
    if (typeof parsed.encryptedKeyBase64 !== 'string' || parsed.encryptedKeyBase64 === '') {
      return null
    }
    return { encryptedKeyBase64: parsed.encryptedKeyBase64 }
  } catch {
    return null
  }
}

export function hasSarvamSpeechApiKey(): boolean {
  // Why: Settings and model-state refresh call this on startup; checking file
  // existence avoids decrypting safeStorage and triggering macOS keychain prompts.
  return existsSync(getSarvamKeyPath())
}

export function saveSarvamSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Sarvam API key is required')
  }
  ensureOrcaDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeSarvamKeyFile(
      Buffer.concat([ENCRYPTED_ENVELOPE_MARKER, safeStorage.encryptString(trimmed)])
    )
    cachedSarvamSpeechApiKey = trimmed
    return
  }

  console.warn(
    '[speech] safeStorage encryption unavailable — storing Sarvam speech key in plaintext'
  )
  writeSarvamKeyFile(Buffer.concat([PLAINTEXT_ENVELOPE_MARKER, Buffer.from(trimmed, 'utf8')]))
  cachedSarvamSpeechApiKey = trimmed
}

export function readSarvamSpeechApiKey(): string {
  if (cachedSarvamSpeechApiKey !== null) {
    return cachedSarvamSpeechApiKey
  }

  const keyPath = getSarvamKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('Sarvam API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    // Self-describing envelope (current format): the marker records exactly how
    // the key was written, so decryption never depends on runtime safeStorage
    // availability matching whatever it was at save time.
    if (startsWithMarker(raw, ENCRYPTED_ENVELOPE_MARKER)) {
      cachedSarvamSpeechApiKey = safeStorage.decryptString(
        raw.subarray(ENCRYPTED_ENVELOPE_MARKER.length)
      )
      return cachedSarvamSpeechApiKey
    }
    if (startsWithMarker(raw, PLAINTEXT_ENVELOPE_MARKER)) {
      cachedSarvamSpeechApiKey = raw.subarray(PLAINTEXT_ENVELOPE_MARKER.length).toString('utf8')
      return cachedSarvamSpeechApiKey
    }
    // Legacy formats written before the envelope existed.
    const legacyJson = readLegacyJsonStoredSarvamKey()
    if (legacyJson) {
      cachedSarvamSpeechApiKey = safeStorage.decryptString(
        Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
      )
      return cachedSarvamSpeechApiKey
    }
    cachedSarvamSpeechApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedSarvamSpeechApiKey
  } catch {
    throw new Error('Sarvam API key could not be decrypted')
  }
}

export function clearSarvamSpeechApiKey(): void {
  cachedSarvamSpeechApiKey = null
  rmSync(getSarvamKeyPath(), { force: true })
}
