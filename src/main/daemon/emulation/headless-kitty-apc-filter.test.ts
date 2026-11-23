import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from './headless-emulator'
import { HeadlessKittyApcFilter } from './headless-kitty-apc-filter'

function filterAcrossChunks(chunks: readonly string[]): string {
  const filter = new HeadlessKittyApcFilter()
  return chunks.map((chunk) => filter.filter(chunk)).join('')
}

async function runRawTerminalLines(chunks: readonly string[]): Promise<string[]> {
  const term = new Terminal({
    cols: 40,
    rows: 10,
    scrollback: 0,
    allowProposedApi: true,
    logLevel: 'off'
  })
  try {
    for (const chunk of chunks) {
      if (chunk) {
        term.write(chunk)
      }
    }
    await new Promise<void>((resolve) => {
      term.write('', resolve)
    })
    const out: string[] = []
    for (let y = 0; y < 10; y += 1) {
      out.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
    }
    return out
  } finally {
    term.dispose()
  }
}

describe('HeadlessKittyApcFilter', () => {
  it('strips Kitty APC sequences across every single-character split boundary while preserving terminal state', async () => {
    const payload = 'AAAA'.repeat(16)
    const stream = `top\x1b_Ga=T,f=100,i=1;${payload}\x1b\\mid\x1b_Xnonkitty\x1b\\!\r\nrow2\x1b_Ga=p;\x1b\x1b[31mred\x1b[0m\r\nrow3\x1b_Gm=1;BBBB\x18kept`

    const baselineLines = await runRawTerminalLines([stream])

    const splitOutputs = await Promise.all(
      Array.from({ length: stream.length + 1 }, (_, split) => {
        const filteredChunks = [stream.slice(0, split), stream.slice(split)]
        const filter = new HeadlessKittyApcFilter()
        return runRawTerminalLines(filteredChunks.map((chunk) => filter.filter(chunk)))
      })
    )
    for (const lines of splitOutputs) {
      expect(lines).toEqual(baselineLines)
    }

    const singleCharFiltered = filterAcrossChunks([...stream])
    expect(await runRawTerminalLines([singleCharFiltered])).toEqual(baselineLines)
  })

  it('keeps HeadlessEmulator screen rows, CWD, title, and partialEscapeTail identical with Kitty APC stripped', async () => {
    const payload = 'A'.repeat(4096)
    const chunks = [
      '\x1b]0;Codex Title\x07\x1b]7;file:///tmp/demo\x07header\x1b[?2026h\x1b_',
      `Ga=T,t=d,f=100,i=9,m=1;${payload}\x1b`,
      `\\\x1b_Gm=0;${payload}\x1b\\footer\x1b[?2026l\x1b_Gunterminated`
    ]

    const headless = new HeadlessEmulator({ cols: 40, rows: 10 })
    try {
      for (const chunk of chunks) {
        expect(headless.writeSync(chunk)).toBe(true)
      }
      const rawLines = await runRawTerminalLines(chunks)
      expect(headless.getVisibleLines()).toEqual(rawLines)
      expect(headless.getCwd()).toBe('/tmp/demo')
      expect(headless.getSnapshot().lastTitle).toBe('Codex Title')
      expect(headless.partialEscapeTailAnsi).toBe('\x1b_Gunterminated')
    } finally {
      headless.dispose()
    }
  })
})
