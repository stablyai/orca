import * as SecureStore from 'expo-secure-store'
import nacl from 'tweetnacl'
import { z } from 'zod'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/encryption/base64-byte-codec'

// This phone's long-lived X25519 "reader key": sleeping workspaces seal their read-only snapshot to
// its public half. The secret never leaves this keychain item (off iCloud Keychain and backups), and
// it is bound to one device session, so a new enrollment never inherits an old session's key.
const STORE_KEY = 'orca.cloud-reader.v1'
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

const RegistrationSchema = z.object({ keyId: z.string().min(1), registeredAt: z.number() })
const StoredSchema = z.object({
  deviceSessionId: z.string().min(1),
  secretKeyB64: z.string(),
  registration: RegistrationSchema.nullable()
})

export type CloudReaderKeyRegistration = z.infer<typeof RegistrationSchema>

export type CloudReaderKey = {
  deviceSessionId: string
  publicKeyB64: string
  secretKey: Uint8Array
  /** The control plane's id for this key (`rk_…`), once registered. */
  registration: CloudReaderKeyRegistration | null
}

type Stored = z.infer<typeof StoredSchema>

// Every read-modify-write runs in order, so two callers never mint two keys.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

async function readStored(): Promise<Stored | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS)
  if (!raw) {
    return null
  }
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw))
    return parsed.success && decodeBase64Bytes(parsed.data.secretKeyB64).length === 32
      ? parsed.data
      : null
  } catch {
    return null
  }
}

function toKey(stored: Stored): CloudReaderKey {
  const secretKey = decodeBase64Bytes(stored.secretKeyB64)
  return {
    deviceSessionId: stored.deviceSessionId,
    publicKeyB64: encodeBase64Bytes(nacl.scalarMult.base(new Uint8Array(secretKey))),
    secretKey,
    registration: stored.registration
  }
}

/** This session's reader key, generated on first use (only once the phone is enrolled). */
export function loadCloudReaderKey(deviceSessionId: string): Promise<CloudReaderKey> {
  return serial(async () => {
    const stored = await readStored()
    if (stored && stored.deviceSessionId === deviceSessionId) {
      return toKey(stored)
    }
    const pair = nacl.box.keyPair()
    const fresh: Stored = {
      deviceSessionId,
      secretKeyB64: encodeBase64Bytes(new Uint8Array(pair.secretKey)),
      registration: null
    }
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(fresh), OPTIONS)
    return toKey(fresh)
  })
}

/** Records the control plane's id, unless the key was replaced or dropped meanwhile. */
export function saveCloudReaderKeyRegistration(
  key: Pick<CloudReaderKey, 'deviceSessionId' | 'publicKeyB64'>,
  registration: CloudReaderKeyRegistration | null
): Promise<void> {
  return serial(async () => {
    const stored = await readStored()
    if (!stored || stored.deviceSessionId !== key.deviceSessionId) {
      return
    }
    if (toKey(stored).publicKeyB64 !== key.publicKeyB64) {
      return
    }
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify({ ...stored, registration }), OPTIONS)
  })
}

/** Drops the key with the cloud session: nothing this phone could read outlives its access. */
export function clearCloudReaderKey(): Promise<void> {
  return serial(() => SecureStore.deleteItemAsync(STORE_KEY, OPTIONS))
}
