import * as SecureStore from 'expo-secure-store'
import nacl from 'tweetnacl'
import { z } from 'zod'
import { randomBytes } from '../transport/encryption/e2ee'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/encryption/base64-byte-codec'

// This phone's own Orca Cloud key and enrollment. Kept off iCloud Keychain and backups, like pairing
// credentials, so a restored phone has to be enrolled again rather than inheriting access.
const STORE_KEY = 'orca.cloud-device.v1'
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

const EnrollmentSchema = z.object({
  controlPlaneUrl: z.string().url(),
  deviceSessionId: z.string().min(1),
  label: z.string(),
  enrolledAt: z.number(),
  /** The desktop that lent its sign-in; shown so the user knows which account this is. */
  viaHostName: z.string().optional()
})

const StoredSchema = z.object({
  seedB64: z.string(),
  enrollment: EnrollmentSchema.nullable()
})

export type CloudEnrollment = z.infer<typeof EnrollmentSchema>

export type CloudDeviceIdentity = {
  publicKeyB64: string
  secretKey: Uint8Array
  enrollment: CloudEnrollment | null
}

let cached: Promise<CloudDeviceIdentity> | null = null
const listeners = new Set<() => void>()

function fromSeed(seed: Uint8Array, enrollment: CloudEnrollment | null): CloudDeviceIdentity {
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(seed))
  return { publicKeyB64: encodeBase64Bytes(pair.publicKey), secretKey: pair.secretKey, enrollment }
}

async function write(seed: Uint8Array, enrollment: CloudEnrollment | null): Promise<void> {
  await SecureStore.setItemAsync(
    STORE_KEY,
    JSON.stringify({ seedB64: encodeBase64Bytes(seed), enrollment }),
    OPTIONS
  )
}

async function readSeed(): Promise<{ seed: Uint8Array; enrollment: CloudEnrollment | null }> {
  const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS)
  let parsed: ReturnType<typeof StoredSchema.safeParse> | null = null
  try {
    parsed = raw ? StoredSchema.safeParse(JSON.parse(raw)) : null
  } catch {
    parsed = null
  }
  if (parsed?.success) {
    const seed = decodeBase64Bytes(parsed.data.seedB64)
    if (seed.length === 32) {
      return { seed, enrollment: parsed.data.enrollment }
    }
  }
  // Nothing usable stored: a fresh key. An unreadable old key could never sign again anyway, so
  // its enrollment goes with it and the phone is simply connected again.
  const seed = randomBytes(32)
  await write(seed, null)
  return { seed, enrollment: null }
}

export function loadCloudDeviceIdentity(): Promise<CloudDeviceIdentity> {
  cached ??= readSeed()
    .then(({ seed, enrollment }) => fromSeed(seed, enrollment))
    .catch((error: unknown) => {
      cached = null
      throw error
    })
  return cached
}

export async function saveCloudEnrollment(enrollment: CloudEnrollment): Promise<void> {
  const { seed } = await readSeed()
  await write(seed, enrollment)
  cached = Promise.resolve(fromSeed(seed, enrollment))
  listeners.forEach((listener) => listener())
}

/** Forgets the enrollment and rotates the key, so a revoked session can never be reused. */
export async function clearCloudEnrollment(): Promise<void> {
  const seed = randomBytes(32)
  await write(seed, null)
  cached = Promise.resolve(fromSeed(seed, null))
  listeners.forEach((listener) => listener())
}

export function subscribeCloudDeviceIdentity(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
