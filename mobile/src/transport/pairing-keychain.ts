import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

// Why: WHEN_UNLOCKED_THIS_DEVICE_ONLY keeps pairing credentials off iCloud Keychain and backup restores.
const BASE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

const GENERATION_STORAGE_KEY = 'orca:pairing-keychain-generation'
const PRESENCE_STORAGE_PREFIX = 'orca:pairing-keychain-presence:'
const SERVICE_PREFIX = 'orca.pairing.v'
// Why: every generation adds one read probe per miss; bound pathological recovery cost.
const MAX_GENERATION = 8

/**
 * Why: expo-secure-store shares one Android keystore alias across every
 * unauthenticated item under a keychain service. The #6600 rejection proves
 * encryption reached expo's null-message GeneralSecurityException branch; a
 * fresh service selects a distinct alias and can recover an alias-local fault.
 */
function serviceForGeneration(generation: number): string | undefined {
  // Why: generation 0 must keep expo's default service so existing credentials stay readable.
  return generation <= 0 ? undefined : `${SERVICE_PREFIX}${generation}`
}

function optionsForGeneration(generation: number): SecureStore.SecureStoreOptions {
  const keychainService = serviceForGeneration(generation)
  return keychainService ? { ...BASE_OPTIONS, keychainService } : BASE_OPTIONS
}

type LoadedGeneration =
  | { generation: number; pending: boolean; reliable: true }
  | { generation: 0; pending: false; reliable: false; error: unknown }

type GenerationState = { generation: number; pending: boolean }
type PresenceChange = { storageKey: string; previousRaw: string | null }

let cachedGeneration: GenerationState | null = null
let keychainMutation: Promise<void> = Promise.resolve()

function parseGeneration(raw: string | null): LoadedGeneration {
  if (raw === null) {
    return { generation: 0, pending: false, reliable: true }
  }
  const pending = raw.endsWith(':pending')
  const generationRaw = pending ? raw.slice(0, -':pending'.length) : raw
  const parsed = Number(generationRaw)
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_GENERATION ||
    (pending && parsed === 0) ||
    String(parsed) !== generationRaw
  ) {
    return {
      generation: 0,
      pending: false,
      reliable: false,
      error: new Error('pairing keychain generation record is invalid')
    }
  }
  return { generation: parsed, pending, reliable: true }
}

function parsePresenceGeneration(raw: string | null): number | null {
  if (raw === null) {
    return null
  }
  const parsed = Number(raw)
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_GENERATION ||
    String(parsed) !== raw
  ) {
    throw new Error('pairing keychain presence record is invalid')
  }
  return parsed
}

function presenceStorageKey(key: string): string {
  return `${PRESENCE_STORAGE_PREFIX}${key}`
}

async function loadPresenceGeneration(key: string): Promise<number | null> {
  if (Platform.OS !== 'android') {
    return null
  }
  return parsePresenceGeneration(await AsyncStorage.getItem(presenceStorageKey(key)))
}

async function loadGeneration(): Promise<LoadedGeneration> {
  if (cachedGeneration !== null) {
    return { ...cachedGeneration, reliable: true }
  }
  try {
    const loaded = parseGeneration(await AsyncStorage.getItem(GENERATION_STORAGE_KEY))
    if (loaded.reliable) {
      cachedGeneration = { generation: loaded.generation, pending: loaded.pending }
    }
    return loaded
  } catch (error) {
    // Why: don't cache or rotate from a guess; a later read may recover the durable pointer.
    return { generation: 0, pending: false, reliable: false, error }
  }
}

// Why: reads only walk back from the recorded generation, so persist before writing under it.
async function commitGeneration(generation: number, pending: boolean): Promise<void> {
  const raw = pending ? `${generation}:pending` : String(generation)
  await AsyncStorage.setItem(GENERATION_STORAGE_KEY, raw)
  cachedGeneration = { generation, pending }
}

function enqueueKeychainMutation(operation: () => Promise<void>): Promise<void> {
  const mutation = keychainMutation.then(operation)
  keychainMutation = mutation.catch(() => {})
  return mutation
}

async function preparePresenceWrite(
  key: string,
  generation: number
): Promise<PresenceChange | null> {
  if (Platform.OS !== 'android') {
    return null
  }
  // Why: Expo Android returns null for both absent and undecryptable entries.
  const storageKey = presenceStorageKey(key)
  const previousRaw = await AsyncStorage.getItem(storageKey)
  parsePresenceGeneration(previousRaw)
  await AsyncStorage.setItem(storageKey, String(generation))
  return { storageKey, previousRaw }
}

async function restorePresence(change: PresenceChange | null): Promise<void> {
  if (!change) {
    return
  }
  if (change.previousRaw === null) {
    await AsyncStorage.removeItem(change.storageKey)
    return
  }
  await AsyncStorage.setItem(change.storageKey, change.previousRaw)
}

async function setItemAtGeneration(key: string, value: string, generation: number): Promise<void> {
  const presenceChange = await preparePresenceWrite(key, generation)
  try {
    await SecureStore.setItemAsync(key, value, optionsForGeneration(generation))
  } catch (error) {
    // Why: a failed rollback leaves reads fail-closed at the attempted generation.
    await restorePresence(presenceChange).catch(() => {})
    throw error
  }
}

export async function readPairingKeychainItem(key: string): Promise<string | null> {
  await keychainMutation
  const presenceGeneration = await loadPresenceGeneration(key)
  if (presenceGeneration !== null) {
    const value = await SecureStore.getItemAsync(key, optionsForGeneration(presenceGeneration))
    if (value === null) {
      // Why: Android reports an undecryptable entry as null, so failing closed here latched
      // callers out of their own orphan cleanup forever; report absent instead. The presence
      // record must survive — it is the only thing that keeps a later read from resurrecting
      // the superseded value under an older generation. Callers clear it via delete or a
      // re-pair write, so a legitimately-current older value is traded for re-pairing.
      return null
    }
    return value
  }
  const loaded = await loadGeneration()
  const firstCandidate = loaded.reliable ? loaded.generation : MAX_GENERATION
  for (let candidate = firstCandidate; candidate >= 0; candidate -= 1) {
    const value = await SecureStore.getItemAsync(key, optionsForGeneration(candidate))
    if (value !== null) {
      return value
    }
  }
  return null
}

async function writePairingKeychainItemImpl(key: string, value: string): Promise<void> {
  const loaded = await loadGeneration()
  if (!loaded.reliable) {
    throw loaded.error
  }
  const generation = loaded.generation
  let firstError: unknown
  try {
    await setItemAtGeneration(key, value, generation)
    if (loaded.pending) {
      await commitGeneration(generation, false)
    }
    return
  } catch (error) {
    firstError = error
  }

  // Why: retry an unconfirmed alias instead of exhausting generations on a device-wide failure.
  if (loaded.pending || !isAndroidEncryptionFailure(firstError)) {
    throw firstError
  }
  const rotated = generation + 1
  if (rotated > MAX_GENERATION) {
    throw firstError
  }
  try {
    await commitGeneration(rotated, true)
  } catch {
    throw firstError
  }
  try {
    await setItemAtGeneration(key, value, rotated)
    await commitGeneration(rotated, false)
  } catch {
    throw firstError
  }
}

function isAndroidEncryptionFailure(error: unknown): boolean {
  if (Platform.OS !== 'android' || !error || typeof error !== 'object') {
    return false
  }
  const message = 'message' in error ? error.message : null
  return typeof message === 'string' && message.includes('Could not encrypt the value for key')
}

export function writePairingKeychainItem(key: string, value: string): Promise<void> {
  return enqueueKeychainMutation(() => writePairingKeychainItemImpl(key, value))
}

async function deletePairingKeychainItemImpl(key: string): Promise<void> {
  const loaded = await loadGeneration()
  const firstCandidate = loaded.reliable ? loaded.generation : MAX_GENERATION
  let firstError: unknown
  for (let candidate = firstCandidate; candidate >= 0; candidate -= 1) {
    try {
      await SecureStore.deleteItemAsync(key, optionsForGeneration(candidate))
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== undefined) {
    throw firstError
  }
  if (Platform.OS === 'android') {
    await AsyncStorage.removeItem(presenceStorageKey(key))
  }
}

export function deletePairingKeychainItem(key: string): Promise<void> {
  return enqueueKeychainMutation(() => deletePairingKeychainItemImpl(key))
}

/** Test-only: drop cached generation and mutation state between cases. */
export function resetPairingKeychainForTests(): void {
  cachedGeneration = null
  keychainMutation = Promise.resolve()
}
