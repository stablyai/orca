import AsyncStorage from '@react-native-async-storage/async-storage'

const CUSTOM_ACCESSORY_KEYS_STORAGE_KEY = 'orca:custom-accessory-keys'

export type CustomKey = {
  id: string
  label: string
  bytes: string
  enter: boolean
}

export async function loadCustomKeys(
  options: { fallback?: CustomKey[]; rejectReadFailure?: boolean } = {}
): Promise<CustomKey[]> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY)
    if (raw === null) {
      return options.fallback ?? []
    }
    const value: unknown = JSON.parse(raw)
    if (
      !Array.isArray(value) ||
      !value.every(
        (key) =>
          key !== null &&
          typeof key === 'object' &&
          typeof key.id === 'string' &&
          typeof key.label === 'string' &&
          typeof key.bytes === 'string' &&
          typeof key.enter === 'boolean'
      )
    ) {
      throw new Error('Invalid custom shortcuts')
    }
    return value as CustomKey[]
  } catch (error) {
    if (options.rejectReadFailure) {
      throw error
    }
    return options.fallback ?? []
  }
}

export async function saveCustomKeys(keys: CustomKey[]): Promise<void> {
  await AsyncStorage.setItem(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY, JSON.stringify(keys))
}
