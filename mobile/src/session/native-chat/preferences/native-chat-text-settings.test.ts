import { describe, expect, it, vi } from 'vitest'

const storage = new Map<string, string>()

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(storage.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value)
      return Promise.resolve()
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key)
      return Promise.resolve()
    })
  }
}))

vi.mock('react-native', () => ({
  Dimensions: {
    get: () => ({ width: 390, height: 844 }),
    addEventListener: () => ({ remove: () => undefined })
  }
}))

import {
  NATIVE_CHAT_TEXT_KEY,
  reloadNativeChatTextSettings,
  useNativeChatTextSettingsSnapshot
} from './native-chat-text-settings'

let currentFont: string | null = null
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useSyncExternalStore: (_sub: unknown, get: () => { settings: { font: string } }) => {
      currentFont = get().settings.font
      return get()
    }
  }
})

describe('native-chat-text-settings font parsing', () => {
  it('honors system font written by pre-#49443 native builds without v: 2', async () => {
    storage.set(
      NATIVE_CHAT_TEXT_KEY,
      JSON.stringify({ size: 14, font: 'system', lineSpacing: 'default' })
    )
    await reloadNativeChatTextSettings()
    useNativeChatTextSettingsSnapshot()
    expect(currentFont).toBe('system')

    storage.set(
      NATIVE_CHAT_TEXT_KEY,
      JSON.stringify({ size: 14, font: 'mono', lineSpacing: 'default' })
    )
    await reloadNativeChatTextSettings()
    useNativeChatTextSettingsSnapshot()
    expect(currentFont).toBe('mono')

    storage.set(
      NATIVE_CHAT_TEXT_KEY,
      JSON.stringify({ size: 14, font: 'system', lineSpacing: 'default' })
    )
    await reloadNativeChatTextSettings()
    useNativeChatTextSettingsSnapshot()
    expect(currentFont).toBe('system')

    storage.set(
      NATIVE_CHAT_TEXT_KEY,
      JSON.stringify({ size: 14, font: 'serif', lineSpacing: 'default' })
    )
    await reloadNativeChatTextSettings()
    useNativeChatTextSettingsSnapshot()
    expect(currentFont).toBe('serif')
  })
})
