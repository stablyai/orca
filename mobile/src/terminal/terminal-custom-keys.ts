import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'

const CUSTOM_ACCESSORY_KEYS_STORAGE_KEY = 'orca:custom-accessory-keys'

export type CustomKey = {
  id: string
  label: string
  bytes: string
  enter: boolean
}

function isCustomKey(value: unknown): value is CustomKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'label' in value &&
    typeof value.label === 'string' &&
    'bytes' in value &&
    typeof value.bytes === 'string' &&
    'enter' in value &&
    typeof value.enter === 'boolean'
  )
}

// Propagate read failures so writes cannot invent an empty baseline; malformed stored keys may be replaced.
async function readStoredCustomKeys(): Promise<CustomKey[]> {
  const raw = await AsyncStorage.getItem(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY)
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isCustomKey) : []
  } catch {
    return []
  }
}

export function loadCustomKeys(): Promise<CustomKey[]> {
  return readStoredCustomKeys().catch(() => [])
}

function writeCustomKeys(keys: CustomKey[]): Promise<void> {
  // Persist before mirroring; page refusals must never update the accepted-value cache.
  return persistMirrored(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY, JSON.stringify(keys))
}

// Serialize all list mutations so add/remove read the last accepted write.
let customKeysWriteTurn: Promise<unknown> = Promise.resolve()

function inCustomKeysWriteTurn<T>(write: () => Promise<T>): Promise<T> {
  const run = customKeysWriteTurn.then(write)
  customKeysWriteTurn = run.catch(() => {})
  return run
}

export function saveCustomKeys(keys: CustomKey[]): Promise<void> {
  return inCustomKeysWriteTurn(() => writeCustomKeys(keys))
}

export function updateStoredCustomKeys(
  change: (keys: CustomKey[]) => CustomKey[]
): Promise<CustomKey[]> {
  return inCustomKeysWriteTurn(async () => {
    const updated = change(await readStoredCustomKeys())
    await writeCustomKeys(updated)
    return updated
  })
}

// Resolve only after persistence so refused deletes cannot remove rows that reappear on reload.
export function removeCustomKey(id: string): Promise<CustomKey[]> {
  return updateStoredCustomKeys((keys) => keys.filter((key) => key.id !== id))
}
