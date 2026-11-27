// The Gemini API key a person pasted for Orca's Antigravity chat, sealed by the host's OS keyring.

import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { durableWriteTempPath, writeFileDurable } from '../filesystem/durable-file-write'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'

const FILE = 'gemini-api-key.enc'

const keyPath = (): string => join(getProfileUserDataPath(), ANTIGRAVITY_CHAT_HOME_FOLDER, FILE)

/** Existence only, so status reads never ask the keychain to decrypt. */
export async function hasAntigravityChatApiKey(): Promise<boolean> {
  return (await stat(keyPath()).catch(() => null)) !== null
}

/** Null when none is saved or it no longer decrypts, so the environment's key can serve instead. */
export async function readAntigravityChatApiKey(): Promise<string | null> {
  const sealed = await readFile(keyPath(), 'utf8').catch(() => null)
  if (!sealed) {
    return null
  }
  try {
    return getSecretStore().decryptString(Buffer.from(sealed, 'base64')).trim() || null
  } catch (error) {
    console.warn('[antigravity] saved Gemini API key could not be decrypted:', error)
    return null
  }
}

export async function saveAntigravityChatApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Enter a Gemini API key.')
  }
  const store = getSecretStore()
  // Never write the key unsealed or weakly sealed; the environment variable remains the alternative.
  if (!store.isEncryptionAvailable() || store.describeProtectionGap() !== null) {
    throw new Error(
      "This host can't encrypt saved keys. Set GEMINI_API_KEY in your shell or in Antigravity's environment variables instead."
    )
  }
  const path = keyPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFileDurable(
    durableWriteTempPath(path),
    path,
    store.encryptString(trimmed).toString('base64'),
    0o600
  )
}

export async function clearAntigravityChatApiKey(): Promise<void> {
  await rm(keyPath(), { force: true })
}
