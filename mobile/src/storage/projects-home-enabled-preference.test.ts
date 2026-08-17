import AsyncStorage from '@react-native-async-storage/async-storage'
import { describe, expect, it, vi } from 'vitest'
import { saveProjectsHomeEnabled } from './preferences'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { setItem: vi.fn() }
}))

describe('projects home enabled preference', () => {
  it('absorbs best-effort storage failures', async () => {
    vi.mocked(AsyncStorage.setItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(saveProjectsHomeEnabled(true)).resolves.toBeUndefined()
  })
})
