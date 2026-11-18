import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  // Annotated rather than asserted: the literal alone narrows `raw` to `null`.
  const held: {
    raw: string | null
    holdWrites: Promise<void> | null
  } = { raw: null, holdWrites: null }
  return held
})

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => {
      return store.raw
    },
    setItem: async (_key: string, value: string) => {
      await store.holdWrites
      store.raw = value
    }
  }
}))
import { removeCustomKey, saveCustomKeys } from './terminal-custom-keys'
import { retainMirroredStorage } from '../../storage/mirrored-storage-keys'

const CUSTOM_KEYS = 'orca:custom-accessory-keys'
let releaseStorage = () => {}

afterEach(() => releaseStorage())

beforeEach(() => {
  releaseStorage = retainMirroredStorage([CUSTOM_KEYS])
  store.raw = null
  store.holdWrites = null
})

describe('removing a custom key', () => {
  const kept = { id: 'custom-1', label: 'Ctrl+C', bytes: '\u0003', enter: false }
  const removed = { id: 'custom-2', label: 'Ctrl+D', bytes: '\u0004', enter: false }

  it('removes from the list a settings save in flight stored, not the list before it', async () => {
    const third = { id: 'custom-3', label: 'Ctrl+Z', bytes: '\u001a', enter: false }
    store.raw = JSON.stringify([kept, removed, third])
    let releaseWrites: () => void = () => {}
    store.holdWrites = new Promise((resolve) => {
      releaseWrites = resolve
    })
    const reorder = saveCustomKeys([third, removed, kept])
    const removal = removeCustomKey(removed.id)
    releaseWrites()
    await Promise.all([reorder, removal])
    expect(JSON.parse(store.raw ?? '[]')).toEqual([third, kept])
  })
})
