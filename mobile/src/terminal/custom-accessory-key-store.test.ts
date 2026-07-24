import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_ACCESSORY_KEY_MAX_BYTES_CHARACTERS,
  CUSTOM_ACCESSORY_KEYS_MAX_ENTRIES,
  CUSTOM_ACCESSORY_KEYS_MAX_STORAGE_CHARACTERS,
  loadCustomKeys,
  saveCustomKeys,
  type CustomKey
} from './custom-accessory-key-store'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

function customKey(index: number, bytes = 'echo ok'): CustomKey {
  return { id: `key-${index}`, label: `Key ${index}`, bytes, enter: false }
}

describe('custom accessory key store', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined)
  })

  it('round-trips normal custom keys unchanged', async () => {
    const keys = [customKey(1), customKey(2)]
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(keys))

    await expect(loadCustomKeys()).resolves.toEqual(keys)
    await expect(saveCustomKeys(keys)).resolves.toEqual(keys)
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:custom-accessory-keys',
      JSON.stringify(keys)
    )
  })

  it('accepts the exact key count and evicts oldest at one over', async () => {
    const exact = Array.from({ length: CUSTOM_ACCESSORY_KEYS_MAX_ENTRIES }, (_, index) =>
      customKey(index)
    )
    await expect(saveCustomKeys(exact)).resolves.toEqual(exact)

    const oneOver = [...exact, customKey(CUSTOM_ACCESSORY_KEYS_MAX_ENTRIES)]
    const retained = await saveCustomKeys(oneOver)
    expect(retained).toHaveLength(CUSTOM_ACCESSORY_KEYS_MAX_ENTRIES)
    expect(retained[0]?.id).toBe('key-1')
    expect(retained.at(-1)?.id).toBe(`key-${CUSTOM_ACCESSORY_KEYS_MAX_ENTRIES}`)
  })

  it('accepts the exact macro length and drops one character over', async () => {
    const exact = customKey(1, 'x'.repeat(CUSTOM_ACCESSORY_KEY_MAX_BYTES_CHARACTERS))
    const oversized = customKey(2, 'x'.repeat(CUSTOM_ACCESSORY_KEY_MAX_BYTES_CHARACTERS + 1))

    await expect(saveCustomKeys([exact, oversized])).resolves.toEqual([exact])
  })

  it('rejects durable JSON over the storage character budget before parsing', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      'x'.repeat(CUSTOM_ACCESSORY_KEYS_MAX_STORAGE_CHARACTERS + 1)
    )

    await expect(loadCustomKeys()).resolves.toEqual([])
  })
})
