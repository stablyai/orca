// This device's long-lived X25519 "reader key", one per Orca profile. A sleeping Orca Cloud
// workspace seals its read snapshot to every registered reader key allowed to open it; the secret
// half never leaves this machine. It is sealed by the OS keychain (safeStorage at level 'os'); with
// no real keychain the feature is off rather than keeping a long-lived secret in the clear.
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assessSecretProtection } from '../host/electron-secret-store'
import { guardedSafeStorage } from '../host/safe-storage-availability'
import { writeSecureJsonFile } from '../../shared/secure-storage/secure-file'
import { base64ToBytes, bytesToBase64 } from '../../shared/cloud-workspaces/sealed-grant'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'
import { generateGrantRecipientKey, x25519PublicKeyOf } from './sealed-grant-node'

const READER_KEY_FILE_NAME = 'cloud-reader-key.json.enc'

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
function osReaderKeyCodec(): ReaderKeyCodec | null {
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

function getCloudReaderKeyPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), READER_KEY_FILE_NAME)
}

export function createCloudReaderKeyStore(deps: {
  pathFor: (profileId: string) => string
  codec: () => ReaderKeyCodec | null
  now?: () => number
}) {
  const cache = new Map<string, CloudReaderKey>()
  // One load per key file at a time, so two first reads can never mint two keys.
  const loading = new Map<string, Promise<ReaderKeyLoad>>()

  /** The sealed key on disk, or null when there is none or this keychain cannot open it. */
  async function readExisting(path: string, codec: ReaderKeyCodec): Promise<CloudReaderKey | null> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (
        !isRecord(parsed) ||
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
      return { secretKey, publicKeyB64: bytesToBase64(x25519PublicKeyOf(secretKey)) }
    } catch {
      return null
    }
  }

  async function loadUncached(path: string, codec: ReaderKeyCodec): Promise<ReaderKeyLoad> {
    const existing = await readExisting(path, codec)
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
      // Once per profile; the shared writer applies owner-only permissions (and Windows ACLs).
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
  }

  return {
    /** The profile's existing key, if any; never creates one. */
    async peek(profileId: string): Promise<CloudReaderKey | null> {
      const codec = deps.codec()
      const path = deps.pathFor(profileId)
      const cached = cache.get(path)
      if (cached || !codec) {
        return cached ?? null
      }
      const existing = await readExisting(path, codec)
      if (existing) {
        cache.set(path, existing)
      }
      return existing
    },
    /** The profile's key, created on first use. A key the keychain can no longer open is replaced. */
    async load(profileId: string): Promise<ReaderKeyLoad> {
      const codec = deps.codec()
      if (!codec) {
        return { ok: false, reason: 'keychain_unavailable', message: KEYCHAIN_MESSAGE }
      }
      const path = deps.pathFor(profileId)
      const cached = cache.get(path)
      if (cached) {
        return { ok: true, key: cached }
      }
      let pending = loading.get(path)
      if (!pending) {
        pending = loadUncached(path, codec).finally(() => loading.delete(path))
        loading.set(path, pending)
      }
      return pending
    },
    /** Sign-out: the next account on this profile gets a new key (never one an old account knew). */
    async clear(profileId: string): Promise<void> {
      const path = deps.pathFor(profileId)
      // A first load still in flight would otherwise write its key back after this.
      await loading.get(path)
      cache.get(path)?.secretKey.fill(0)
      cache.delete(path)
      await rm(path, { force: true })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type CloudReaderKeyStore = ReturnType<typeof createCloudReaderKeyStore>

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

// Sign-out revokes the key server-side through the cloud workspaces service (it owns the client
// and the registration id). A seam so profile code never loads that service.
let revoker: ((timeoutMs: number) => Promise<void>) | null = null

export function setCloudReaderKeyRevoker(next: typeof revoker): void {
  revoker = next
}

const READER_KEY_REVOKE_TIMEOUT_MS = 2_500

/** Best effort and bounded: resolves within `timeoutMs` whatever the network does. */
export async function revokeCloudReaderKeyBestEffort(
  timeoutMs = READER_KEY_REVOKE_TIMEOUT_MS
): Promise<void> {
  const run = revoker
  if (!run) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => run(timeoutMs))
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Sign-out / profile reset hook: drop the profile's reader key (memory and disk). */
export async function clearCloudReaderKey(profileId: string, userDataPath: string): Promise<void> {
  try {
    await getCloudReaderKeyStore(userDataPath).clear(profileId)
  } catch (error) {
    console.error(`[orca-cloud] clearing the reader key failed: ${String(error)}`)
  }
}
