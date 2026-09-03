import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

import {
  clearGrokResetAttemptAfterAuthoritativeResponse,
  getOrCreateGrokResetAttempt,
  resetGrokResetAttemptJournalForTests
} from './grok-reset-attempt-journal'

describe('Grok reset attempt journal', () => {
  let values: Map<string, string>

  beforeEach(() => {
    resetGrokResetAttemptJournalForTests()
    values = new Map()
    storage.getItem.mockReset().mockImplementation(async (key: string) => values.get(key) ?? null)
    storage.setItem.mockReset().mockImplementation(async (key: string, value: string) => {
      values.set(key, value)
    })
    storage.removeItem.mockReset().mockImplementation(async (key: string) => values.delete(key))
  })

  it('persists before returning and reuses an unresolved attempt', async () => {
    const create = vi.fn().mockReturnValue('22222222-2222-4222-8222-222222222222')
    const first = await getOrCreateGrokResetAttempt('host-1', create)
    const replay = await getOrCreateGrokResetAttempt('host-1', create)

    expect(replay).toEqual(first)
    expect(create).toHaveBeenCalledOnce()
    expect(storage.setItem).toHaveBeenCalledOnce()
  })

  it('clears only the matching authoritative attempt', async () => {
    const attempt = await getOrCreateGrokResetAttempt(
      'host-1',
      () => '22222222-2222-4222-8222-222222222222'
    )
    await clearGrokResetAttemptAfterAuthoritativeResponse(attempt)

    expect(storage.removeItem).toHaveBeenCalledOnce()
    expect(values.size).toBe(0)
  })
})
