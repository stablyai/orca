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
  await new ReattachedPaintLedger(join(dir, 'ledger.json')).save(
    new Map([['pty-1', entry!]]),
    new Set(['pty-1'])
  )

  const saved = await new ReattachedPaintLedger(join(dir, 'ledger.json')).read('pty-1')
  expect(saved).toMatchObject({ incarnationId: 'inc-1', sequence: 4_096, agent: 'hermes' })
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

it('keeps the proof of a terminal this run never attached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-paint-ledger-'))
  dirs.push(dir)
  const path = join(dir, 'ledger.json')
  const entry = { incarnationId: 'inc-a', sequence: 7, agent: 'hermes' }
  await new ReattachedPaintLedger(path).save(new Map([['pty-a', entry]]), new Set(['pty-a']))
  // A run that attached only pty-b, now unproven, saves nothing of its own.
  await new ReattachedPaintLedger(path).save(new Map(), new Set(['pty-b']))
  expect(await new ReattachedPaintLedger(path).read('pty-a')).toMatchObject(entry)
  // A run that attached pty-a drops it once it is no longer proven.
  await new ReattachedPaintLedger(path).save(new Map(), new Set(['pty-a']))
  expect(await new ReattachedPaintLedger(path).read('pty-a')).toBeNull()
})

// #44696 Windows QA: an agent the user typed has no launch, title or mail record of its identity.
it('proves a typed agent the restart identifies, with no identity recorded at quit', () => {
  const typed = Object.assign(hermesPane(), { foregroundAgent: null })
  paint(typed, '\x1b]133;C\x07❯ Ask me anything…')
  const entry = reattachedPaintEntry(typed, 12)
  expect(entry).toEqual({ incarnationId: 'inc-1', sequence: 12 })
  const current = { incarnationId: 'inc-1', reattachedSequence: 12 }
  expect(retainedFrameIsProven(entry, { ...current, agent: 'hermes' })).toBe(true)
  expect(
    retainedFrameIsProven(entry, { ...current, reattachedSequence: 13, agent: 'hermes' })
  ).toBe(false)
  // A recorded agent still has to match.
  const recorded = reattachedPaintEntry(hermesPane(typed), 12)
  expect(retainedFrameIsProven(recorded, { ...current, agent: 'cline' })).toBe(false)
})

it("records Claude only once its own composer painted, for hosts that can't repaint", () => {
  const banner = Object.assign(hermesPane(), { foregroundAgent: 'claude' as const })
  paint(banner, '\x1b]133;C\x07Claude Code v2 starting…')
  expect(reattachedPaintEntry(banner, 30)).toBeNull()

  const composer = Object.assign(hermesPane(), { foregroundAgent: 'claude' as const })
  paint(composer, '\x1b]133;C\x07\x1b[?2031h\x1b[?2004h│ ❯\u00a0 │')
  const entry = reattachedPaintEntry(composer, 30)
  expect(entry).toEqual({ incarnationId: 'inc-1', sequence: 30, agent: 'claude' })
  const current = { incarnationId: 'inc-1', reattachedSequence: 30, agent: 'claude' }
  // A restore that reads the frame before asking for a repaint trusts only screen-ruled entries.
  expect(retainedFrameIsProven(entry, current)).toBe(false)
  expect(retainedFrameIsProven(entry, current, { anyRecordedAgent: true })).toBe(true)
  expect(
    retainedFrameIsProven(entry, { ...current, reattachedSequence: 31 }, { anyRecordedAgent: true })
  ).toBe(false)
})
