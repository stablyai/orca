// This device's long-lived X25519 "reader key", one per Orca profile. A sleeping Orca Cloud
// workspace seals its read snapshot to every registered reader key allowed to open it; the secret
// half never leaves this machine. It is sealed by the OS keychain (safeStorage at level 'os'); with
// no real keychain the feature is off rather than keeping a long-lived secret in the clear.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assessSecretProtection } from '../host/electron-secret-store'
import { guardedSafeStorage } from '../host/safe-storage-availability'
import { writeSecureJsonFile } from '../../shared/secure-storage/secure-file'
import { base64ToBytes, bytesToBase64 } from '../../shared/cloud-workspaces/sealed-grant'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'
import { generateGrantRecipientKey, nodeSealedGrantPrimitives } from './sealed-grant-node'

export const READER_KEY_FILE_NAME = 'cloud-reader-key.json.enc'

export type ReaderKeyCodec = {
  encrypt: (plain: string) => Buffer
  decrypt: (sealed: Buffer) => string
}

export type CloudReaderKey = {
  /** 32-byte X25519 secret. Callers must not keep or zero it; the store owns the buffer. */
  secretKey: Uint8Array
  publicKeyB64: string
}

export type ReaderKeyLoad =
  | { ok: true; key: CloudReaderKey }
  | { ok: false; reason: 'keychain_unavailable' | 'storage_failed'; message: string }

type PersistedReaderKey = {
  version: 1
  format: 'electron-safe-storage-v1'
  createdAt: number
  ciphertext: string
}

const KEYCHAIN_MESSAGE =
  'Reading sleeping workspaces needs the OS keychain to protect this device’s key.'

/** The OS keychain, or null when it is missing or only obfuscates (Linux basic_text). */
export function osReaderKeyCodec(): ReaderKeyCodec | null {
  try {
    if (!guardedSafeStorage.isEncryptionAvailable() || assessSecretProtection().level !== 'os') {
      return null
    }
  } catch {
    return null
  }
  return {
    encrypt: (plain) => guardedSafeStorage.encryptString(plain),
    decrypt: (sealed) => guardedSafeStorage.decryptString(sealed)
  }
}

export function getCloudReaderKeyPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), READER_KEY_FILE_NAME)
}

export function createCloudReaderKeyStore(deps: {
  pathFor: (profileId: string) => string
  codec: () => ReaderKeyCodec | null
  now?: () => number
}) {
  const cache = new Map<string, CloudReaderKey>()

  function decode(path: string, codec: ReaderKeyCodec): CloudReaderKey | null {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedReaderKey>
      if (
        parsed.version !== 1 ||
        parsed.format !== 'electron-safe-storage-v1' ||
        typeof parsed.ciphertext !== 'string'
      ) {
        return null
      }
      const secretKey = base64ToBytes(codec.decrypt(Buffer.from(parsed.ciphertext, 'base64')))
      if (secretKey.length !== 32) {
        return null
      }
      return {
        secretKey,
        publicKeyB64: bytesToBase64(
          nodeSealedGrantPrimitives.x25519PublicKey(secretKey) as Uint8Array
        )
      }
    } catch {
      return null
    }
  }

  return {
    /** The profile's key, created on first use. A key the keychain can no longer open is replaced. */
    load(profileId: string): ReaderKeyLoad {
      const codec = deps.codec()
      if (!codec) {
        return { ok: false, reason: 'keychain_unavailable', message: KEYCHAIN_MESSAGE }
      }
      const path = deps.pathFor(profileId)
      const cached = cache.get(path)
      if (cached) {
        return { ok: true, key: cached }
      }
      const existing = existsSync(path) ? decode(path, codec) : null
      if (existing) {
        cache.set(path, existing)
        return { ok: true, key: existing }
      }
      // A new key only means snapshots taken before it are not readable here until the next sleep.
      const fresh = generateGrantRecipientKey()
      try {
        const persisted: PersistedReaderKey = {
          version: 1,
          format: 'electron-safe-storage-v1',
          createdAt: (deps.now ?? Date.now)(),
          ciphertext: codec.encrypt(bytesToBase64(fresh.secretKey)).toString('base64')
        }
        writeSecureJsonFile(path, persisted)
      } catch (error) {
        fresh.secretKey.fill(0)
        return {
          ok: false,
          reason: 'storage_failed',
          message: `Could not save this device’s reader key: ${String(error).slice(0, 120)}`
        }
      }
      const key = { secretKey: fresh.secretKey, publicKeyB64: fresh.publicKeyB64 }
      cache.set(path, key)
      return { ok: true, key }
    },
    /** Sign-out: the next account on this profile gets a new key (never one an old account knew). */
    clear(profileId: string): void {
      const path = deps.pathFor(profileId)
      cache.get(path)?.secretKey.fill(0)
      cache.delete(path)
      rmSync(path, { force: true })
    }
  }
}

export type CloudReaderKeyStore = ReturnType<typeof createCloudReaderKeyStore>

let defaultStore: { userDataPath: string; store: CloudReaderKeyStore } | null = null

/** The process-wide store for this user data directory (the OS keychain codec). */
export function getCloudReaderKeyStore(userDataPath: string): CloudReaderKeyStore {
  if (defaultStore?.userDataPath !== userDataPath) {
    defaultStore = {
      userDataPath,
      store: createCloudReaderKeyStore({
        pathFor: (profileId) => getCloudReaderKeyPath(profileId, userDataPath),
        codec: osReaderKeyCodec
      })
    }
  }
  return defaultStore.store
}

/** Sign-out / profile reset hook: drop the profile's reader key (memory and disk). */
export function clearCloudReaderKey(profileId: string, userDataPath: string): void {
  try {
    getCloudReaderKeyStore(userDataPath).clear(profileId)
  } catch (error) {
    console.error(`[orca-cloud] clearing the reader key failed: ${String(error)}`)
  }
}
