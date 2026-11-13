import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { MAX_TAIL_CHARS } from '../output/tail/terminal-tail-limits'
import { lastSupportedIndex } from '../../../../shared/terminal/output/terminal-supported-occurrences'
import { expect, it, vi } from 'vitest'
import {
  setTerminalLineOrigins,
  terminalOriginSpan,
  terminalScreenSupport,
  joinedTerminalOrigins,
  terminalSupportQuery
} from '../../../../shared/terminal/output/terminal-content-origin'
import { buildVisibleSnapshotReadFallback } from '../output/tail/terminal-tail-read'
import { compileTextAnchor } from '../../agent-state-rules/agent-state-text-anchors'
import { compileScreenCondition } from '../../agent-state-rules/agent-state-rule-matchers'
import {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason
} from './terminal-wait-tail-state'
import {
  appendWaitBlockedCarry,
  createWaitBlockedAppendedCarry,
  readWaitBlockedCarry
} from './wait-blocked-check-state'
import { restoreFromReattachedReadyScreen } from './reattached-ready-screen'
import {
  readFreebuffScreenStatus,
  FreebuffScreenStatusTracker
} from '../../../../shared/freebuff-screen-status'
import { TerminalCommandPaint, terminalTitleIsPredecessor } from '../input/terminal-command-paint'
import { buildTerminalActionText, readTerminalActionText } from '../output/terminal-action-text'
import { extractAllOscTitleEntries } from '../../../../shared/agent-status/title/osc-title-extraction'

it.each([false, true])('hands the actual adjacent title to one command (split=%s)', (split) => {
  const paint = new TerminalCommandPaint()
  const record = { commandPaint: paint, lastOscTitle: 'claude' }
  const title = '\x1b]0;claude\x07'
  const boundary = '\x1b]133;B\x07\x1b]133;C\x07'
  const ingest = (data: string) => {
    paint.observe(data, data)
    for (const entry of extractAllOscTitleEntries(data)) {
      paint.observeTitle(entry.title, entry.end)
    }
  }
  ingest(`\x1b]133;C\x07${title}`)
  if (split) {
    ingest(title)
    ingest(boundary)
    ingest('composer')
  } else {
    ingest(`${title}${boundary}composer`)
  }
  expect(terminalTitleIsPredecessor(record)).toBe(false)
  ingest('\x1b]133;C\x07next command')
  expect(terminalTitleIsPredecessor(record)).toBe(true)
})

it('does not hand off an interrupted title or an application-zone title', () => {
  const paint = new TerminalCommandPaint()
  const record = { commandPaint: paint, lastOscTitle: 'claude' }
  const title = '\x1b]0;claude\x07'
  const ingest = (data: string) => {
    paint.observe(data, data)
    for (const entry of extractAllOscTitleEntries(data)) {
      paint.observeTitle(entry.title, entry.end)
    }
  }
  ingest(`\x1b]133;C\x07${title}`)
  ingest(`${title}interruption\x1b]133;B\x07\x1b]133;C\x07output`)
  expect(terminalTitleIsPredecessor(record)).toBe(true)
  ingest(`\x1b[?1049h${title}\x1b]133;B\x07\x1b]133;C\x07answer`)
  ingest('\x1b[?1049l\x1b]133;C\x07next command')
  expect(terminalTitleIsPredecessor(record)).toBe(true)
})

it('keeps caller-owned action views out of a stable empty-record cache', () => {
  const paint = new TerminalCommandPaint()
  paint.observe('\x1b]133;C\x07', '')
  const record = { commandPaint: paint, tailBuffer: [], tailPartialLine: '', preview: '' }
  const stable = readTerminalActionText(record)
  const lines = ['Permission required\nThis command requires permission\nAllow once\nReject']
  setTerminalLineOrigins(lines, [terminalOriginSpan(lines[0]!.length, paint.contentOrigin)])
  const current = buildTerminalActionText(lines, paint.contentOrigin)
  expect(current.text).toContain('Permission required')
  expect(current.query?.(0, 19) ?? true).toBe(true)
  paint.observe('\x1b]133;C\x07', '')
  expect(buildTerminalActionText(lines, paint.contentOrigin).query?.(0, 19)).toBe(false)
  expect(stable.text).toBe('')
  expect(readTerminalActionText(record).text).toBe('')
})

it('preserves predecessor coordinates through visible row and UTF16 prefix limits', () => {
  const owner = {}
  const old = { owner, epoch: 1 }
  const scope = { owner, epoch: 2 }
  const lines = ['omitted', `${'😀'.repeat(20000)}ready`, 'current']
  setTerminalLineOrigins(lines, [
    terminalOriginSpan(7, old),
    terminalOriginSpan(lines[1]!.length, old),
    terminalOriginSpan(7, scope)
  ])
  const projected = buildVisibleSnapshotReadFallback(
    { handle: 'x', status: 'running', tail: [], truncated: false, nextCursor: null },
    lines,
    2
  )
  expect(projected.tail).toHaveLength(2)
  expect(projected.tail[0]).toMatch(/ready$/)
  const query = terminalScreenSupport(projected.tail, scope)!
  expect(query(0, projected.tail[0]!.length - 5, projected.tail[0]!.length)).toBe(false)
  expect(query(1, 0, 7)).toBe(true)
})

it('applies the existing grammar once to the selected eligible anchor and bottom row', () => {
  const text = 'header complete\nheader incomplete'
  const find = compileTextAnchor(
    { region: 'text', find: { lastOf: 'header' }, after: { contains: 'complete' } },
    { state: 'idle', strength: 'strong', requiresQuiet: false }
  )
  // Use exact suffix wording so the latest header fails despite an earlier eligible complete one.
  const input = text.replace('incomplete', 'unfinished')
  expect(find(input, () => true)).toBeNull()
  expect(find(input, (start) => start < 16)).toMatchObject({ index: 0 })
  const match = compileScreenCondition({
    region: 'screen',
    endsWithinBottom: 3,
    rows: [{ contains: 'top' }, { contains: 'bottom' }]
  })
  expect(match(['top', 'bottom', 'wrong', 'bottom'], () => true)).toBe(false)
  expect(match(['top', 'bottom', 'wrong', 'bottom'], (row) => row !== 3)).toBe(true)
})

it('does not promote a known predecessor screen on reattach and retains unknown fallback', () => {
  const owner = {}
  const scope = { owner, epoch: 2 }
  const lines = ['─ ready │ model', '❯ Ask me anything…']
  setTerminalLineOrigins(
    lines,
    lines.map((line) => terminalOriginSpan(line.length, { owner, epoch: 1 }))
  )
  const applyIdle = vi.fn()
  const restore = {
    agent: 'hermes' as const,
    readScreen: () => ({ lines, alternateScreen: false }),
    readContentScope: () => scope,
    readOutputClockAt: () => 1,
    isCurrent: () => true,
    applyIdle
  }
  restoreFromReattachedReadyScreen(restore)
  expect(applyIdle).not.toHaveBeenCalled()
  restoreFromReattachedReadyScreen({
    ...restore,
    readScreen: () => ({ lines: [...lines], alternateScreen: false })
  })
  expect(applyIdle).toHaveBeenCalledOnce()
})

it('qualifies Freebuff supports before deduplication and keeps unknown grammar', async () => {
  const owner = {}
  const scope = { owner, epoch: 2 }
  const recording = readRuntimeFixture('freebuff-ready')
  const ready = `${recording.slice(recording.indexOf('\x1b[?1049h')).split('\x1b[?2026l')[0]!}\x1b[?2026l`
  const emulator = new HeadlessEmulator({ cols: 120, rows: 40 })
  let lines: string[]
  try {
    await emulator.write(ready)
    lines = emulator.getVisibleLines()
  } finally {
    emulator.dispose()
  }
  const old = lines.map((line) => terminalOriginSpan(line.length, { owner, epoch: 1 }))
  setTerminalLineOrigins(lines, old)
  const joined = joinedTerminalOrigins(lines)
  const support = terminalSupportQuery(joined.origins, scope)
  const tracker = new FreebuffScreenStatusTracker(true)
  expect(tracker.observe('erase', () => ({ lines, alternate: true, support }))).toBeNull()
  expect(tracker.observe('paint', () => ({ lines, alternate: true }))).toMatchObject({
    state: 'done',
    sessionBoundary: true
  })
  expect(
    readFreebuffScreenStatus(
      ['freebuff found agent files in this repository', 'Load and run these? [y/N]'],
      false
    )
  ).toMatchObject({ state: 'blocked' })
  expect(readFreebuffScreenStatus(['Press ENTER to login...'], true, () => false)).toBeNull()
})

it('restamps current in-place and split blockers after clear without renewing a cross-command predecessor', () => {
  const paint = new TerminalCommandPaint()
  paint.observe('\x1b]133;C\x07', '')
  const prompt =
    'Permission required\nThis command requires permission\nAllow once\nAllow always\nReject\n'
  const state = (text: string, epoch = paint.commandEpoch) => {
    const lines = text.trimEnd().split('\n')
    setTerminalLineOrigins(
      lines,
      lines.map((line) =>
        terminalOriginSpan(line.length, { owner: paint.contentOrigin.owner, epoch })
      )
    )
    return computeTerminalTailWaitState(lines, '', '', {
      tailBuffer: lines,
      tailPartialLine: '',
      preview: '',
      commandPaint: paint
    })
  }
  const previous = state(prompt)
  expect(previous.signal).not.toBeNull()
  const appended = terminalOriginSpan(prompt.length, paint.contentOrigin)
  expect(
    tailGainedNewerBlockedReason(previous, state(prompt), prompt, appended, paint.contentOrigin)
  ).toBe(true)
  const carry = createWaitBlockedAppendedCarry()
  appendWaitBlockedCarry(carry, prompt.slice(0, 20), terminalOriginSpan(20, paint.contentOrigin))
  appendWaitBlockedCarry(
    carry,
    prompt.slice(20),
    terminalOriginSpan(prompt.length - 20, paint.contentOrigin)
  )
  const joined = readWaitBlockedCarry(carry)
  expect(
    tailGainedNewerBlockedReason(
      previous,
      state(prompt),
      joined.text,
      joined.origins,
      paint.contentOrigin
    )
  ).toBe(true)
  const capped = createWaitBlockedAppendedCarry()
  appendWaitBlockedCarry(
    capped,
    'x'.repeat(MAX_TAIL_CHARS),
    terminalOriginSpan(MAX_TAIL_CHARS, paint.contentOrigin)
  )
  appendWaitBlockedCarry(capped, prompt, appended)
  const retained = readWaitBlockedCarry(capped)
  expect(retained.text).toHaveLength(MAX_TAIL_CHARS)
  expect(
    tailGainedNewerBlockedReason(
      previous,
      state(prompt),
      retained.text,
      retained.origins,
      paint.contentOrigin
    )
  ).toBe(true)
  const oldEpoch = paint.commandEpoch
  paint.observe('\x1b]133;C\x07', '')
  expect(
    tailGainedNewerBlockedReason(
      previous,
      state(prompt, oldEpoch),
      joined.text,
      joined.origins,
      paint.contentOrigin
    )
  ).toBe(false)
})

it.each([100, 1000])(
  'indexes %i old occurrences once instead of scanning every run for every hit',
  (count) => {
    const owner = {}
    const scope = { owner, epoch: 2 }
    let comparisons = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: relational comparisons coerce these test coordinates to their exact numeric values, including in the copied index.
    const coordinate = (value: number) =>
      ({
        [Symbol.toPrimitive]: () => {
          comparisons++
          return value
        }
      }) as unknown as number
    const runs = Array.from({ length: count }, (_, index) => ({
      start: coordinate(index * 4),
      end: coordinate(index * 4 + 3),
      origin: { owner, epoch: 1 }
    }))
    const query = terminalSupportQuery(runs, scope)
    expect(lastSupportedIndex('old '.repeat(count), 'old', query)).toBe(-1)
    // Construction plus logarithmic lookup of each hit; a copied-index linear scan exceeds this bound.
    expect(comparisons).toBeLessThanOrEqual(count * (Math.ceil(Math.log2(count + 1)) + 4))
    const seam = terminalSupportQuery(
      [
        { start: 0, end: 2, origin: { owner, epoch: 1 } },
        { start: 2, end: 4, origin: { owner, epoch: 1 } }
      ],
      scope
    )!
    expect(seam(2, 2)).toBe(true)
    expect(seam(1, 1)).toBe(false)
  }
)
