import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'ios', Version: '27' } }))
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.0.60' } } }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() }
}))

beforeEach(() => {
  vi.resetModules()
  const storage = new Map<string, string>()
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => storage.get(key) ?? null)
  vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    storage.set(key, value)
  })
})

it('keeps a log entry when the thrown error has an unreadable stack', async () => {
  const { recordNativeRenderError, NATIVE_APP_LOG_ID } = await import('./native-render-log')
  const failure = new Error('bad stack')
  Object.defineProperty(failure, 'stack', {
    get() {
      throw new Error('unreadable')
    }
  })
  recordNativeRenderError(failure, 'pair-scan')
  const { connectionLogStore } = await import('./connection/persisted-connection-log-store')
  expect(connectionLogStore.get(NATIVE_APP_LOG_ID)).toEqual([
    expect.objectContaining({ level: 'error', detail: '/pair-scan: Error\n' })
  ])
})
