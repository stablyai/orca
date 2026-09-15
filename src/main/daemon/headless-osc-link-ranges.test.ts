import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

// Why this suite: collectHeadlessOscLinkRanges skips its per-cell scan when
// xterm holds no OSC 8 registration. That skip is only safe if it can never
// fire while a link is reachable, so each case below pins one way it could.
let emulator: HeadlessEmulator | undefined

const link = (uri: string, text: string): string => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`

afterEach(() => {
  emulator?.dispose()
  emulator = undefined
})

describe('headless OSC link ranges', () => {
  it('finds a link written into the buffer', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write(`before ${link('https://example.com/a', 'CLICK')} after`)

    const ranges = emulator.getSnapshot().oscLinks ?? []
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toMatchObject({ row: 0, uri: 'https://example.com/a' })
  })

  it('returns nothing for a buffer that never emitted a link', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('plain output with no hyperlink\r\n'.repeat(50))

    expect(emulator.getSnapshot().oscLinks).toEqual([])
  })

  // The dangerous case: restored ranges are seeded without xterm registering
  // anything, so an early-out keyed only on the registry would drop them.
  it('still maps restored ranges when the buffer itself has no link', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('restored row')
    const restored = { row: 0, startCol: 0, endCol: 4, uri: 'https://example.com/restored' }
    emulator.setRestoredOscLinks([restored])

    expect(emulator.getSnapshot().oscLinks).toEqual([restored])
  })

  it('finds links far down a long scrollback, not just the visible screen', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 5_000 })
    await emulator.write(`${link('https://example.com/top', 'TOP')}\r\n`)
    await emulator.write('filler\r\n'.repeat(2_000))

    const ranges = emulator.getSnapshot({ scrollbackRows: 5_000 }).oscLinks ?? []
    expect(ranges.map((range) => range.uri)).toContain('https://example.com/top')
  })

  it('keeps every distinct link when several are present', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write(
      `${link('https://example.com/1', 'ONE')} ${link('https://example.com/2', 'TWO')}`
    )

    const uris = (emulator.getSnapshot().oscLinks ?? []).map((range) => range.uri)
    expect(uris).toContain('https://example.com/1')
    expect(uris).toContain('https://example.com/2')
  })
})
