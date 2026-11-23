import { afterEach, describe, expect, it, vi } from 'vitest'
import { threadMuteSaves } from './connector-thread-mute-saves'

vi.mock('../external-conversations/external-conversation-link-writes', () => ({
  writeLinkFact: () => true
}))

afterEach(() => {
  vi.useRealTimers()
})

describe('a thread mute whose save fails', () => {
  // A mention is answered through a failing disk; its unmute must still reach disk on its own,
  // without waiting for another mute change.
  it('is saved again until one save lands', async () => {
    vi.useFakeTimers()
    let failures = 2
    let saved = 0
    const flushPendingOrThrowAsync = async (): Promise<void> => {
      if (failures > 0) {
        failures -= 1
        throw new Error('disk full')
      }
      saved += 1
    }
    const write = threadMuteSaves({ flushPendingOrThrowAsync } as unknown as Parameters<
      typeof threadMuteSaves
    >[0])
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(write({ source: 'slack', externalId: 'T:C:1.2:U' }, false)).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(saved).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saved).toBe(1)
  })
})
