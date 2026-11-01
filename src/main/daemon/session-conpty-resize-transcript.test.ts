import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { PtyOwnerBackend } from '../../shared/pty-owner-backend'
import { Session } from './session'

const FIXTURES = join(__dirname, '../runtime/__fixtures__')
const TRANSCRIPT = readFileSync(join(FIXTURES, 'conpty-1-23-wsl-resize-repaint.txt'), 'utf8')
const META: {
  cols: number
  rows: number
  resizes: { cols: number; rows: number; byteOffset: number }[]
} = JSON.parse(readFileSync(join(FIXTURES, 'conpty-1-23-wsl-resize-repaint.meta.json'), 'utf8'))
const LONG_LINE = Array.from({ length: 61 }, (_, i) => String(1000 + i)).join(' ')

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

/** Logical lines of the daemon's saved screen, with soft-wrapped rows joined back together. */
async function savedLogicalLines(ownerBackend: PtyOwnerBackend): Promise<string[]> {
  const subprocess = createMockSubprocess()
  session = new Session({
    sessionId: 'conpty-transcript',
    cols: META.cols,
    rows: META.rows,
    subprocess,
    shellReadySupported: false,
    ownerBackend
  })
  // The transcript's offsets count bytes; it is ASCII apart from escapes, so they match string indexes.
  let offset = 0
  for (const resize of META.resizes) {
    subprocess.simulateData(TRANSCRIPT.slice(offset, resize.byteOffset))
    session.resize(resize.cols, resize.rows)
    offset = resize.byteOffset
  }
  subprocess.simulateData(TRANSCRIPT.slice(offset))
  await session.settleShellOwnershipConfirmation()
  const snapshot = session.takePendingOutput(true, { teardownSnapshot: true })?.snapshot
  expect(snapshot).toBeTruthy()
  const terminal = new Terminal({
    cols: snapshot!.cols,
    rows: snapshot!.rows,
    scrollback: 5000,
    allowProposedApi: true
  })
  await new Promise<void>((resolve) =>
    terminal.write(`${snapshot!.rehydrateSequences}${snapshot!.snapshotAnsi}`, resolve)
  )
  const lines: string[] = []
  for (let i = 0; i < terminal.buffer.active.length; i++) {
    const line = terminal.buffer.active.getLine(i)
    const text = line?.translateToString(true) ?? ''
    if (line?.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text
    } else {
      lines.push(text)
    }
  }
  terminal.dispose()
  return lines.map((line) => line.trimEnd())
}

// Captured from ConPTY 1.23 hosting wsl.exe: each resize repaints only ConPTY's own viewport from
// the top, never the rows that scrolled off, and the 302-column line arrives unbroken.
describe('daemon screen through a captured ConPTY resize transcript', () => {
  it('keeps every line once, in order, with no joined prompts and the long line whole', async () => {
    const lines = await savedLogicalLines('windows-wsl')
    const numbers = lines.filter((line) => /^\d+$/.test(line)).map(Number)
    expect(numbers).toEqual(Array.from({ length: 80 }, (_, i) => i + 1))
    expect(lines.filter((line) => line === LONG_LINE)).toHaveLength(1)
    expect(lines.filter((line) => /\$.*orca@/.test(line))).toEqual([])
  })

  // Control: the Unix grow model pulls history back under ConPTY's repaint.
  it('loses or repeats lines without the ConPTY model', async () => {
    const lines = await savedLogicalLines('posix-pty')
    const numbers = lines.filter((line) => /^\d+$/.test(line)).map(Number)
    expect(numbers).not.toEqual(Array.from({ length: 80 }, (_, i) => i + 1))
  })
})
