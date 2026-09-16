import { describe, expect, it } from 'vitest'
import { remoteSessionContentLines } from './remote-session-content-lines'

// Mirrors REMOTE_CONTENT_YIELD_CHAR_COUNT in the implementation.
const YIELD_CHAR_COUNT = 256 * 1024

async function collect(content: string, signal: AbortSignal): Promise<string[]> {
  const lines: string[] = []
  for await (const line of remoteSessionContentLines(content, signal)) {
    lines.push(line)
  }
  return lines
}

describe('remote session content lines', () => {
  it.each([
    ['', ['']],
    ['\n', ['', '']],
    ['one\r\ntwo\n', ['one', 'two', '']],
    ['one\rtwo\r', ['one\rtwo']],
    ['x'.repeat(300_000), ['x'.repeat(300_000)]],
    [`${'x'.repeat(YIELD_CHAR_COUNT + 1)}\ny`, ['x'.repeat(YIELD_CHAR_COUNT + 1), 'y']],
    [`${'x'.repeat(YIELD_CHAR_COUNT)}\r\ny`, ['x'.repeat(YIELD_CHAR_COUNT), 'y']],
    [`${'x'.repeat(YIELD_CHAR_COUNT * 2)}\ny`, ['x'.repeat(YIELD_CHAR_COUNT * 2), 'y']]
  ])('preserves line boundaries for input %#', async (content, expected) => {
    expect(await collect(content as string, new AbortController().signal)).toEqual(expected)
  })

  it('rejects an already cancelled scan even for empty content', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(collect('', controller.signal)).rejects.toThrow()
  })

  it.each(['\n'.repeat(400), `${'x'.repeat(300_000)}\nlast`])(
    'observes cancellation at an event-loop yield for input %#',
    async (content) => {
      const controller = new AbortController()
      setImmediate(() => controller.abort())
      await expect(collect(content, controller.signal)).rejects.toThrow()
    }
  )

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
