import { describe, expect, it, vi } from 'vitest'
import { walkSessionFiles } from './session-scanner-discovery'

describe('walkSessionFiles directory reader', () => {
  it('does not turn cancellation into an unreadable-directory miss', async () => {
    const controller = new AbortController()
    const cancelled = new Error('scan cancelled')
    const readDirectory = vi.fn(async () => {
      controller.abort(cancelled)
      throw cancelled
    })

    await expect(
      walkSessionFiles('cancelled', 'codex', [], {
        extensions: new Set(['.jsonl']),
        readDirectory,
        signal: controller.signal
      })
    ).rejects.toBe(cancelled)
  })
})
