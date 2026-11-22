import {
  inCredentialFileOrder,
  credentialFileExists,
  stageCredentialFile
} from '../credentials/credential-file-io'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { readCredentialFileProtection } from '../credentials/credential-file-protection'
import {
  classifyUnenvelopedCredential,
  type SecretAtRestProtection
} from '../../shared/secure-storage/secret-at-rest-protection'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type StoredOpenAiKey = {
  encryptedKeyBase64: string
}

const OPENAI_SPEECH_TOKEN_FILE = 'openai-speech-token.enc'
let cachedOpenAiSpeechApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

async function ensureOrcaDir(): Promise<void> {
  const dir = getOrcaDir()
  if (!(await credentialFileExists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

export function getOpenAiKeyPath(): string {
  return join(getOrcaDir(), OPENAI_SPEECH_TOKEN_FILE)
}

async function readLegacyJsonStoredOpenAiKey(): Promise<StoredOpenAiKey | null> {
  const keyPath = getOpenAiKeyPath()
  if (!(await credentialFileExists(keyPath))) {
    return null
  }
  try {
    const parsed: Partial<StoredOpenAiKey> = JSON.parse(await readFile(keyPath, 'utf8'))
    if (typeof parsed.encryptedKeyBase64 !== 'string' || parsed.encryptedKeyBase64 === '') {
      return null
    }
    return { encryptedKeyBase64: parsed.encryptedKeyBase64 }
  } catch {
    return null
  }
}

export async function hasOpenAiSpeechApiKey(): Promise<boolean> {
  // Existence checks avoid macOS keychain prompts during startup/settings refresh.
  return inCredentialFileOrder(`${getOpenAiKeyPath()}.mutation`, () =>
    credentialFileExists(getOpenAiKeyPath())
  )
}

/** Check host decryption: orcad may not open a desktop safeStorage key even when its file exists. */
export async function canReadOpenAiSpeechApiKey(): Promise<boolean> {
  if (!(await hasOpenAiSpeechApiKey())) {
    return false
  }
  try {
    await readOpenAiSpeechApiKey()
    return true
  } catch {
    return false
  }
}

/** Stored protection, or null when no key exists. */
export async function getOpenAiSpeechApiKeyProtection(): Promise<SecretAtRestProtection | null> {
  return inCredentialFileOrder(`${getOpenAiKeyPath()}.mutation`, async () => {
    // The legacy JSON wrapper only ever held base64 ciphertext, so it is sealed by shape.
    if (await readLegacyJsonStoredOpenAiKey()) {
      return 'sealed'
    }
    return readCredentialFileProtection(getOpenAiKeyPath())
  })
}

export async function saveOpenAiSpeechApiKey(apiKey: string): Promise<void> {
  return inCredentialFileOrder(`${getOpenAiKeyPath()}.mutation`, async () => {
    const trimmed = apiKey.trim()
    if (!trimmed) {
      throw new Error('OpenAI API key is required')
    }
    await ensureOrcaDir()
    if (getSecretStore().isEncryptionAvailable()) {
      await stageCredentialFile(getOpenAiKeyPath(), getSecretStore().encryptString(trimmed))
      cachedOpenAiSpeechApiKey = trimmed
      return
    }

    console.warn('[speech] secret encryption unavailable — storing OpenAI speech key in plaintext')
    await stageCredentialFile(getOpenAiKeyPath(), trimmed)
    cachedOpenAiSpeechApiKey = trimmed
  })
}

export async function readOpenAiSpeechApiKey(): Promise<string> {
  return inCredentialFileOrder(`${getOpenAiKeyPath()}.mutation`, async () => {
    if (cachedOpenAiSpeechApiKey !== null) {
      return cachedOpenAiSpeechApiKey
    }

    const keyPath = getOpenAiKeyPath()
    if (!(await credentialFileExists(keyPath))) {
      throw new Error('OpenAI API key is not configured')
    }
    try {
      const raw = await readFile(keyPath)
      const legacyJson = await readLegacyJsonStoredOpenAiKey()
      if (legacyJson) {
        cachedOpenAiSpeechApiKey = getSecretStore().decryptString(
          Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
        )
        return cachedOpenAiSpeechApiKey
      }
      cachedOpenAiSpeechApiKey = getSecretStore().isEncryptionAvailable()
        ? decryptOrLegacyPlaintext(raw)
        : plaintextOnly(raw)
      return cachedOpenAiSpeechApiKey
    } catch {
      throw new Error('OpenAI API key could not be decrypted')
    }
  })
}

// Without sealing, another store's ciphertext cannot be a usable key.
function plaintextOnly(raw: Buffer): string {
  if (classifyUnenvelopedCredential(raw) !== 'plaintext') {
    throw new Error('sealed by another secret store')
  }
  return raw.toString('utf8')
}

// Keys saved before sealing remain plaintext until migration or re-save.
function decryptOrLegacyPlaintext(raw: Buffer): string {
  try {
    return getSecretStore().decryptString(raw)
  } catch (error) {
    if (classifyUnenvelopedCredential(raw) === 'plaintext') {
      return raw.toString('utf8')
    }
    throw error
  }
}

export async function clearOpenAiSpeechApiKey(): Promise<void> {
  return inCredentialFileOrder(`${getOpenAiKeyPath()}.mutation`, async () => {
    cachedOpenAiSpeechApiKey = null
    await rm(getOpenAiKeyPath(), { force: true })
  })
}
