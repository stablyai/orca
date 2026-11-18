// The Gemini API key a person pasted for Orca's Antigravity chat, sealed by the host's OS keyring.

import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { writeSecureFile } from '../../shared/secure-storage/secure-file'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'

const FILE = 'gemini-api-key.enc'

const keyPath = (): string => join(getProfileUserDataPath(), ANTIGRAVITY_CHAT_HOME_FOLDER, FILE)

/** Existence only, so status reads never ask the keychain to decrypt. */
export async function hasAntigravityChatApiKey(): Promise<boolean> {
  return (await stat(keyPath()).catch(() => null)) !== null
}

export async function readAntigravityChatApiKey(): Promise<string | null> {
  const sealed = await readFile(keyPath(), 'utf8').catch(() => null)
  if (!sealed) {
    return null
  }
  try {
    return getSecretStore().decryptString(Buffer.from(sealed, 'base64')).trim() || null
  } catch (cause) {
    throw new Error(
      "Orca couldn't unlock the saved Gemini API key on this host. Paste it again in Settings.",
      { cause }
    )
  }
}

export function saveAntigravityChatApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Enter a Gemini API key.')
  }
  const store = getSecretStore()
  // Never write the key unsealed; the environment variable remains the alternative.
  if (!store.isEncryptionAvailable()) {
    throw new Error(
      "This host can't encrypt saved keys. Set GEMINI_API_KEY in your shell or in Antigravity's environment variables instead."
    )
  }
  writeSecureFile(keyPath(), store.encryptString(trimmed).toString('base64'), { durable: true })
}

export async function clearAntigravityChatApiKey(): Promise<void> {
  await rm(keyPath(), { force: true })
}
