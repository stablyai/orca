import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'

const PTY_ID = 'repo-1::/tmp/wt@@reflow'
const BANNER = 'ssh banner\r\n$ '
const ERASE = '\x1b[2J'
const ALT_ENTER = '\x1b[?1049h'
const ALT_LEAVE = '\x1b[?1049l'

/** Serves the committed grid the ruled screen trusts; the real controller is absent in unit tests. */
class RuledRuntime extends OrcaRuntimeService {
  private grid: { cols: number; rows: number } | null = null

  commitGrid(cols: number, rows: number): void {
    this.grid = { cols, rows }
  }

  override getTerminalSize(): { cols: number; rows: number } | null {
    return this.grid
  }
}

function paintFrame(cols: number, rows: number, filler: string): string {
  const row = `${filler.repeat(Math.ceil(cols / filler.length)).slice(0, cols - 1)} `
  return `\x1b[H${ERASE}${Array.from({ length: rows }, () => row).join('\r\n')}`
}

async function settle(runtime: RuledRuntime): Promise<void> {
  await runtime['headlessTerminals'].get(PTY_ID)!.writeChain
}

describe('a reattach reflow that nothing resizes again', () => {
  it('recovers the ruled screen once a full frame repaints at the committed size (#38418)', async () => {
    const runtime = new RuledRuntime()
    // Early banner bytes arrive before the size commit, so the model starts on the default grid.
    runtime.onPtyData(PTY_ID, BANNER, 1)
    // The attach commits the measured grid; the reflow leaves the model distrusting its cells.
    runtime.commitGrid(20, 5)
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 20, 5)
    expect(runtime['readRuledScreen'](PTY_ID)).toBeNull()
    // A TUI paints its first full frame — at least cols*rows fresh bytes at this size.
    runtime.onPtyData(PTY_ID, paintFrame(20, 5, 'x'), 2)
    await settle(runtime)
    const ruled = runtime['readRuledScreen'](PTY_ID)
    expect(ruled).not.toBeNull()
    expect(ruled!.lines.some((line) => line.includes('xxxx'))).toBe(true)
  })

  it('keeps distrusting while only a short echo arrived', async () => {
    const runtime = new RuledRuntime()
    runtime.onPtyData(PTY_ID, BANNER, 1)
    runtime.commitGrid(20, 5)
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 20, 5)
    runtime.onPtyData(PTY_ID, 'ok\r\n', 2)
    await settle(runtime)
    expect(runtime['readRuledScreen'](PTY_ID)).toBeNull()
  })

  it('still clears immediately when a real resize repaints off the reflowed grid', async () => {
    const runtime = new RuledRuntime()
    runtime.onPtyData(PTY_ID, BANNER, 1)
    runtime.commitGrid(20, 5)
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 20, 5)
    runtime.commitGrid(30, 5)
    runtime['resizeHeadlessTerminal'](PTY_ID, 30, 5)
    const state = runtime['headlessTerminals'].get(PTY_ID)!
    await settle(runtime)
    expect(state.unrepaintedReflowGrid).toBeUndefined()
    expect(state.reflowRepaintTrust).toBeUndefined()
  })
})

describe('reflow distrust boundaries', () => {
  it('recognizes a full-screen erase split across two chunks', async () => {
    const runtime = new RuledRuntime()
    runtime.onPtyData(PTY_ID, BANNER, 1)
    runtime.commitGrid(20, 5)
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 20, 5)
    runtime.onPtyData(PTY_ID, '\x1b[', 2)
    runtime.onPtyData(PTY_ID, '2J', 3)
    await settle(runtime)
    expect(runtime['readRuledScreen'](PTY_ID)).not.toBeNull()
  })

  it('does not let an alternate-screen erase stand in for the normal buffer', async () => {
    const runtime = new RuledRuntime()
    runtime.onPtyData(PTY_ID, BANNER, 1)
    runtime.commitGrid(20, 5)
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 20, 5)
    runtime.onPtyData(PTY_ID, `${ALT_ENTER}${ERASE}`, 2)
    await settle(runtime)
    // The alternate screen is repainted and readable; the normal buffer behind it is not.
    expect(runtime['readRuledScreen'](PTY_ID)).not.toBeNull()
    runtime.onPtyData(PTY_ID, ALT_LEAVE, 3)
    await settle(runtime)
    expect(runtime['readRuledScreen'](PTY_ID)).toBeNull()
  })

  it('ignores output that was queued before the reflow boundary', async () => {
    const runtime = new RuledRuntime()
    runtime.onPtyData(PTY_ID, BANNER, 1)
    // This erase was emitted before the size commit; it cannot prove the reflowed grid is current.
    runtime.onPtyData(PTY_ID, ERASE, 2)
    runtime.commitGrid(20, 5)
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 20, 5)
    await settle(runtime)
    expect(runtime['readRuledScreen'](PTY_ID)).toBeNull()
    runtime.onPtyData(PTY_ID, paintFrame(20, 5, 'x'), 3)
    await settle(runtime)
    expect(runtime['readRuledScreen'](PTY_ID)).not.toBeNull()
  })
})
