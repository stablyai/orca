import AsyncStorage from '@react-native-async-storage/async-storage'

export const CUSTOM_ACCESSORY_KEYS_STORAGE_KEY = 'orca:custom-accessory-keys'
export const CUSTOM_ACCESSORY_KEYS_MAX_ENTRIES = 128
export const CUSTOM_ACCESSORY_KEYS_MAX_STORAGE_CHARACTERS = 512 * 1024
export const CUSTOM_ACCESSORY_KEY_MAX_ID_CHARACTERS = 256
export const CUSTOM_ACCESSORY_KEY_MAX_LABEL_CHARACTERS = 128
export const CUSTOM_ACCESSORY_KEY_MAX_BYTES_CHARACTERS = 16 * 1024

export type CustomKey = {
  id: string
  label: string
  bytes: string
  enter: boolean
}

export async function loadCustomKeys(): Promise<CustomKey[]> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY)
    if (!raw || raw.length > CUSTOM_ACCESSORY_KEYS_MAX_STORAGE_CHARACTERS) {
      return []
    }
    return retainCustomKeys(JSON.parse(raw) as unknown).keys
  } catch {
    return []
  }
}

export async function saveCustomKeys(keys: CustomKey[]): Promise<CustomKey[]> {
  const retained = retainCustomKeys(keys)
  await AsyncStorage.setItem(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY, retained.serialized)
  return retained.keys
}

function retainCustomKeys(value: unknown): { keys: CustomKey[]; serialized: string } {
  if (!Array.isArray(value)) {
    return { keys: [], serialized: '[]' }
  }
  const retained: Array<{ key: CustomKey; serialized: string }> = []
  let storageCharacters = 2
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (retained.length >= CUSTOM_ACCESSORY_KEYS_MAX_ENTRIES) {
      break
    }
    const key = normalizeCustomKey(value[index])
    if (!key) {
      continue
    }
    const serialized = JSON.stringify(key)
    const nextCharacters = storageCharacters + serialized.length + (retained.length > 0 ? 1 : 0)
    if (nextCharacters > CUSTOM_ACCESSORY_KEYS_MAX_STORAGE_CHARACTERS) {
      continue
    }
    retained.push({ key, serialized })
    storageCharacters = nextCharacters
  }
  retained.reverse()
  return {
    keys: retained.map(({ key }) => key),
    serialized: `[${retained.map(({ serialized }) => serialized).join(',')}]`
  }
}

function normalizeCustomKey(value: unknown): CustomKey | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const key = value as Partial<CustomKey>
  if (
    typeof key.id !== 'string' ||
    key.id.length > CUSTOM_ACCESSORY_KEY_MAX_ID_CHARACTERS ||
    typeof key.label !== 'string' ||
    key.label.length > CUSTOM_ACCESSORY_KEY_MAX_LABEL_CHARACTERS ||
    typeof key.bytes !== 'string' ||
    key.bytes.length > CUSTOM_ACCESSORY_KEY_MAX_BYTES_CHARACTERS ||
    typeof key.enter !== 'boolean'
  ) {
    return null
  }
  return { id: key.id, label: key.label, bytes: key.bytes, enter: key.enter }
}
