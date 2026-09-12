import { describe, expect, it } from 'vitest'
import { remoteSessionContentLines } from './remote-session-content-lines'

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
    ['x'.repeat(300_000), ['x'.repeat(300_000)]]
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
})
