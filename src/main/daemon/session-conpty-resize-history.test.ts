import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { PtyOwnerBackend } from '../../shared/pty-owner-backend'
import { buildFreshShellViewportBlankingSequence } from '../../shared/terminal-fresh-shell-viewport'
import { PROCESS_BOUNDARY_GROUND } from '../../shared/terminal-mode-reset-profiles'
import { Session } from './session'

const COLS = 119
const ROWS = 58
const PROMPT = 'orca@awin:~/projects/p8/deep$ '
const RESTORED = `${Array.from({ length: 6 }, (_, i) => `${PROMPT}echo L${i}\r\nL${i}`).join('\r\n')}\r\n${PROMPT}echo PRESLEEP\r\nPRESLEEP\r\n${PROMPT}`
// The fresh shell's rows, which are all ConPTY knows about.
const SHELL_ROWS = [PROMPT, `${PROMPT}echo WAKE`, 'WAKE', PROMPT]

function createMockSubprocess() {
  let onData: ((data: string) => void) | null = null
  return {
    pid: 12345,
    getForegroundProcess: (): string | null => null,
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill() {},
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill() {},
    signal(_sig: string) {},
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(_cb: (code: number) => void) {},
    dispose() {},
    simulateData(data: string) {
      onData?.(data)
    }
  }
}

let session: Session | null = null

afterEach(() => {
  session?.dispose()
  session = null
})

async function renderRows(ansi: string): Promise<string[]> {
  const terminal = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 5000,
    allowProposedApi: true
  })
  await new Promise<void>((resolve) => terminal.write(ansi, resolve))
  const rows: string[] = []
  for (let i = 0; i < terminal.buffer.active.length; i++) {
    rows.push(terminal.buffer.active.getLine(i)?.translateToString(true) ?? '')
  }
  terminal.dispose()
  return rows
}

/**
 * ConPTY's own screen holds only what the shell wrote, at ConPTY's current height: shrinking keeps
 * the cursor row and drops rows above it, and every resize repaints that screen from the top.
 */
class FakeConpty {
  private lines = [...SHELL_ROWS]
  private cursor = SHELL_ROWS.length - 1

  resize(rows: number): string {
    const dropped = Math.max(0, this.cursor - rows + 1)
    this.lines = this.lines.slice(dropped, dropped + rows)
    this.cursor -= dropped
    const screen = Array.from({ length: rows }, (_, i) => `${this.lines[i] ?? ''}\x1b[K`)
    return `\x1b[H${screen.join('\r\n')}\x1b[${this.cursor + 1};${PROMPT.length + 1}H`
  }
}

async function checkpointAfterResizes(
  ownerBackend: PtyOwnerBackend,
  heights: readonly number[]
): Promise<string[]> {
  const subprocess = createMockSubprocess()
  session = new Session({
    sessionId: 'conpty-resize',
    cols: COLS,
    rows: ROWS,
    subprocess,
    shellReadySupported: false,
    ownerBackend,
    historySeedChunks: [
      RESTORED,
      PROCESS_BOUNDARY_GROUND,
      buildFreshShellViewportBlankingSequence(ROWS)
    ]
  })
  subprocess.simulateData(SHELL_ROWS.join('\r\n'))
  const conpty = new FakeConpty()
  for (const rows of heights) {
    session.resize(COLS, rows)
    subprocess.simulateData(conpty.resize(rows))
  }
  await session.settleShellOwnershipConfirmation()
  const snapshot = session.takePendingOutput(true, { teardownSnapshot: true })?.snapshot
  expect(snapshot).toBeTruthy()
  return renderRows(`${snapshot!.rehydrateSequences}${snapshot!.snapshotAnsi}`)
}

const RESTORED_ROWS = [
  ...Array.from({ length: 6 }, (_, i) => [`${PROMPT}echo L${i}`, `L${i}`]).flat(),
  `${PROMPT}echo PRESLEEP`,
  'PRESLEEP',
  PROMPT
].map((row) => row.trimEnd())

describe('daemon checkpoint after a relaunch resize under ConPTY', () => {
  it.each([[[2, ROWS]], [[10, ROWS]], [[2, 30, ROWS]], [[ROWS + 12, ROWS]]])(
    'keeps every restored and shell row once, in order, through heights %j',
    async (heights) => {
      const rows = (await checkpointAfterResizes('windows-wsl', heights)).map((row) =>
        row.trimEnd()
      )
      const written = rows.filter((row) => row !== '')
      expect(written).toEqual([...RESTORED_ROWS, ...SHELL_ROWS.map((row) => row.trimEnd())])
      // The fresh-shell padding still separates the restored prompt from the new shell.
      const restoredPrompt = rows.indexOf('PRESLEEP') + 1
      expect(rows[restoredPrompt + 1]).toBe('')
    }
  )

  // Control: the Unix grow model pulls history into ConPTY's grid, and its repaint overwrites it.
  it('loses restored history without the ConPTY model', async () => {
    const rows = await checkpointAfterResizes('posix-pty', [2, ROWS])
    expect(rows.filter((row) => /^L\d$/.test(row.trimEnd())).length).toBeLessThan(6)
  })
})
