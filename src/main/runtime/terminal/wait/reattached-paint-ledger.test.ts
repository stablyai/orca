import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  awaitReattachedTerminalPaint,
  hasTerminalCommandPainted,
  observeTerminalCommandPaint,
  type TerminalCommandPaintRecord
} from '../input/terminal-command-paint'
import {
  ReattachedPaintLedger,
  reattachedPaintEntry,
  retainedFrameIsProven,
  type PaintLedgerPty
} from './reattached-paint-ledger'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function hermesPane(record: TerminalCommandPaintRecord = {}): PaintLedgerPty {
  return Object.assign(record, {
    connected: true,
    incarnationId: 'inc-1',
    foregroundAgent: 'hermes' as const,
    launchAgent: null,
    launchCommandAgent: null
  })
}

function paint(pty: TerminalCommandPaintRecord, chunk: string): void {
  observeTerminalCommandPaint(pty, chunk, chunk, 1_000)
}

/** The run after the restart: the same process, reattached, holding until it paints. */
function reattached(): PaintLedgerPty {
  const pty = hermesPane()
  awaitReattachedTerminalPaint(pty, 5_000)
  return pty
}

it("restores a quiet agent's retained frame as its paint when nothing was written since quit", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-paint-ledger-'))
  dirs.push(dir)
  const before = hermesPane()
  paint(before, '\x1b]133;C\x07')
  paint(before, '❯ Ask me anything…')
  const entry = reattachedPaintEntry(before, 4_096)
  expect(entry).toEqual({ incarnationId: 'inc-1', sequence: 4_096, agent: 'hermes' })
  await new ReattachedPaintLedger(join(dir, 'ledger.json')).save(new Map([['pty-1', entry!]]))

  const saved = await new ReattachedPaintLedger(join(dir, 'ledger.json')).read('pty-1')
  const after = reattached()
  expect(hasTerminalCommandPainted(after)).toBe(false)
  const current = { incarnationId: 'inc-1', agent: 'hermes' }
  expect(retainedFrameIsProven(saved, { ...current, reattachedSequence: 4_097 })).toBe(false)
  expect(retainedFrameIsProven(saved, { ...current, reattachedSequence: 4_096 })).toBe(true)
  after.commandPaint?.vouchRetainedPaint()
  expect(hasTerminalCommandPainted(after)).toBe(true)
  // Proven again at the next quit, until a command boundary.
  expect(reattachedPaintEntry(after, 4_096)).not.toBeNull()
})

it('records nothing for a command whose paint was never attributed', () => {
  const markerless = hermesPane()
  paint(markerless, '❯ Ask me anything…')
  expect(reattachedPaintEntry(markerless, 10)).toBeNull()

  const unpainted = hermesPane()
  paint(unpainted, '\x1b]133;C\x07')
  expect(reattachedPaintEntry(unpainted, 10)).toBeNull()

  const finished = hermesPane()
  paint(finished, '\x1b]133;C\x07❯ Ask me anything…')
  paint(finished, '\x1b]133;D;0\x07')
  expect(reattachedPaintEntry(finished, 10)).toBeNull()

  const notReattachedHost = hermesPane()
  paint(notReattachedHost, '\x1b]133;C\x07❯ Ask me anything…')
  expect(reattachedPaintEntry(notReattachedHost, undefined)).toBeNull()
})
