import { describe, expect, it } from 'vitest'
import { remoteSessionContentLines } from './remote-session-content-lines'

const YIELD_CHAR_COUNT = 256 * 1024

describe('remote session content lines', () => {
  it('observes cancellation inside a newline-free segment before emitting its line', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    setImmediate(() => controller.abort())
    const scan = (async () => {
      for await (const line of remoteSessionContentLines(
        'x'.repeat(YIELD_CHAR_COUNT * 3),
        controller.signal
      )) {
        seen.push(line)
      }
    })()
    await expect(scan).rejects.toThrow()
    expect(seen).toEqual([])
  })
})
