import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { resizeLikeOwnPty } from './conpty-reflow-viewport'
import { HeadlessEmulator } from './headless-emulator'

const WIDE = 120
const NARROW = 40
const ROWS = 10

/** A ConPTY screen whose history holds rows that rejoin when it widens, so widening corrects. */
function conptyScreenNeedingWidenCorrection(): HeadlessEmulator {
  const emulator = new HeadlessEmulator({
    cols: NARROW,
    rows: ROWS,
    windowsPty: { backend: 'conpty', buildNumber: 26100 }
  })
  const rows = Array.from({ length: 30 }, (_, i) => `${'x'.repeat(70)} line ${i}`)
  emulator.writeSync(`${rows.join('\r\n')}\r\n$ `)
  return emulator
}

function screenText(emulator: HeadlessEmulator): string {
  return emulator.getVisibleLines().join('\n')
}

describe('ConPTY resize correction while an escape sequence is unfinished', () => {
  it('leaves a split SGR whole, so its tail is never printed as text', async () => {
    const emulator = conptyScreenNeedingWidenCorrection()
    await emulator.write('\x1b[3')
    emulator.resize(WIDE, ROWS)
    await emulator.write('1mRED\x1b[0m')
    const text = screenText(emulator)
    expect(text).toContain('$ RED')
    expect(text).not.toContain('1mRED')
    emulator.dispose()
  })

  it('leaves a split OSC title whole, so its tail is never printed as text', async () => {
    const emulator = conptyScreenNeedingWidenCorrection()
    await emulator.write('\x1b]0;my ti')
    emulator.resize(WIDE, ROWS)
    await emulator.write('tle\x07done')
    const text = screenText(emulator)
    expect(text).toContain('$ done')
    expect(text).not.toContain('tle')
    emulator.dispose()
  })
})

const write = (terminal: Terminal, data: string): Promise<void> =>
  new Promise((resolve) => terminal.write(data, resolve))

/**
 * A ConPTY screen with history above, the prompt mid-screen and blank rows below it: narrowing
 * rewraps the long rows, which pushes rows into scrollback that the correction brings back.
 */
async function conptyScreenNeedingNarrowCorrection(tail = ''): Promise<Terminal> {
  const terminal = new Terminal({
    cols: WIDE,
    rows: ROWS,
    scrollback: 100,
    allowProposedApi: true,
    windowsPty: { backend: 'conpty', buildNumber: 26100 }
  })
  const history = Array.from({ length: 12 }, (_, i) => `short ${i}`)
  const wrapping = Array.from({ length: 3 }, (_, i) => `${'x'.repeat(70)} L${i}`)
  // Scrolls 'short 10' to the top, then puts the cursor back after the prompt on row 6.
  await write(
    terminal,
    `${[...history, ...wrapping].join('\r\n')}\r\n$ \r\n\r\n\r\n\r\n\x1b[4A\x1b[3G${tail}`
  )
  return terminal
}

async function narrow(terminal: Terminal): Promise<void> {
  let correction = ''
  resizeLikeOwnPty(terminal, NARROW, ROWS, (data) => {
    correction += data
  })
  await write(terminal, correction)
}

function row(terminal: Terminal, y: number): string {
  const buffer = terminal.buffer.active
  return buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? ''
}

describe('ConPTY resize correction when narrowing', () => {
  it('brings pushed rows back, keeping the viewport top', async () => {
    const terminal = await conptyScreenNeedingNarrowCorrection()
    await narrow(terminal)
    expect(row(terminal, 0)).toBe('short 10')
    expect(row(terminal, 8)).toBe('$ ')
    terminal.dispose()
  })

  it('skips the correction inside an app scroll region (DECSTBM)', async () => {
    const terminal = await conptyScreenNeedingNarrowCorrection('\x1b[1;9r\x1b[6;3H')
    await narrow(terminal)
    // xterm's own placement: the rewrapped rows stay pushed into scrollback.
    expect(row(terminal, 0)).toBe(`${'x'.repeat(30)} L0`)
    terminal.dispose()
  })

  it('moves a saved cursor (DECSC) with its row, so DECRC lands on the prompt', async () => {
    const terminal = await conptyScreenNeedingNarrowCorrection('\x1b7')
    await narrow(terminal)
    await write(terminal, '\x1b8X')
    expect(row(terminal, 0)).toBe('short 10')
    expect(row(terminal, 8)).toBe('$ X')
    terminal.dispose()
  })

  // xterm's own reflow keeps savedY within ybase + rows - 1; DECRC also restricts the cursor.
  it('moves a cursor saved on a popped row to the new bottom row', async () => {
    const terminal = await conptyScreenNeedingNarrowCorrection('\x1b[10;1H\x1b7\x1b[6;3H')
    await narrow(terminal)
    await write(terminal, '\x1b8X')
    expect(row(terminal, ROWS - 1)).toBe('X')
    terminal.dispose()
  })

  it('keeps a background-coloured blank row rather than popping it', async () => {
    const terminal = await conptyScreenNeedingNarrowCorrection(
      '\x1b[10;1H\x1b[44m\x1b[K\x1b[0m\x1b[6;3H'
    )
    await narrow(terminal)
    const buffer = terminal.buffer.active
    expect(
      buffer
        .getLine(buffer.baseY + ROWS - 1)
        ?.getCell(0)
        ?.isBgPalette()
    ).toBe(true)
    terminal.dispose()
  })
})
