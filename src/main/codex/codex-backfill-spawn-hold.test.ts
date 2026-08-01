import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexBackfillPaneHoldState } from '../../shared/codex-backfill-status-types'
import type * as CodexStateDbModule from './codex-state-db'

const isCodexBackfillIndexPendingMock = vi.fn<(home: string) => boolean>()
const readCodexStateDbBackfillStatusMock = vi.fn()

vi.mock('./codex-state-db', () => ({
  isCodexBackfillIndexPending: (home: string) => isCodexBackfillIndexPendingMock(home),
  readCodexStateDbBackfillStatus: (home: string) => readCodexStateDbBackfillStatusMock(home)
}))

import {
  CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS,
  CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS,
  createCodexBackfillPaneHoldRegistry,
  evaluateCodexBackfillHoldPoll,
  shouldHoldCodexSpawnForBackfill,
  type CodexBackfillHoldPollResult
} from './codex-backfill-spawn-hold'

describe('shouldHoldCodexSpawnForBackfill', () => {
  const base = {
    launchAgent: 'codex' as string | undefined,
    startupCommand: 'codex' as string | undefined,
    connectionId: undefined as string | null | undefined,
    codexHomePath: '/home/user/.codex' as string | null
  }

  it('holds a local codex launch with a pending index', () => {
    expect(shouldHoldCodexSpawnForBackfill({ ...base, isPending: () => true })).toBe(true)
  })

  it('passes through non-codex launches', () => {
    expect(
      shouldHoldCodexSpawnForBackfill({ ...base, launchAgent: 'claude', isPending: () => true })
    ).toBe(false)
    expect(
      shouldHoldCodexSpawnForBackfill({ ...base, launchAgent: undefined, isPending: () => true })
    ).toBe(false)
  })

  it('passes through SSH panes (connectionId set)', () => {
    expect(
      shouldHoldCodexSpawnForBackfill({ ...base, connectionId: 'conn-1', isPending: () => true })
    ).toBe(false)
  })

  it('passes through when there is no startup command to withhold', () => {
    expect(
      shouldHoldCodexSpawnForBackfill({ ...base, startupCommand: undefined, isPending: () => true })
    ).toBe(false)
  })

  it('passes through when the effective codex home is unresolvable', () => {
    expect(
      shouldHoldCodexSpawnForBackfill({ ...base, codexHomePath: null, isPending: () => true })
    ).toBe(false)
  })

  it('fails open when the pending check throws', () => {
    expect(
      shouldHoldCodexSpawnForBackfill({
        ...base,
        isPending: () => {
          throw new Error('sqlite exploded')
        }
      })
    ).toBe(false)
  })

  it('passes through when the index is not pending', () => {
    expect(shouldHoldCodexSpawnForBackfill({ ...base, isPending: () => false })).toBe(false)
  })

  // Why: cold-restored codex panes spawn BEFORE the prewarm creates the state DB; the real predicate's
  // >=100-session-files arm must hold them through that window (#11828 validated startup race).
  it('holds via the real default predicate for a missing DB with >=100 session files', async () => {
    const real = await vi.importActual<typeof CodexStateDbModule>('./codex-state-db')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-home-'))
    const day = path.join(home, 'sessions', '2026', '07', '01')
    fs.mkdirSync(day, { recursive: true })
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(day, `rollout-${i}.jsonl`), '')
    }
    expect(
      shouldHoldCodexSpawnForBackfill({
        ...base,
        codexHomePath: home,
        isPending: real.isCodexBackfillIndexPending
      })
    ).toBe(true)
  })
})

describe('evaluateCodexBackfillHoldPoll', () => {
  beforeEach(() => {
    isCodexBackfillIndexPendingMock.mockReset()
    readCodexStateDbBackfillStatusMock.mockReset()
  })

  it('keeps holding (pending, unreadable) on an unreadable status read', () => {
    readCodexStateDbBackfillStatusMock.mockReturnValue({
      kind: 'unreadable',
      stateDbPath: '/x/state_5.sqlite',
      error: 'SQLITE_BUSY'
    })
    expect(evaluateCodexBackfillHoldPoll('/x')).toEqual({
      pending: true,
      unreadable: true,
      lastWatermark: null
    })
  })

  it('keeps holding (pending, unreadable) when the read throws', () => {
    readCodexStateDbBackfillStatusMock.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(evaluateCodexBackfillHoldPoll('/x')).toEqual({
      pending: true,
      unreadable: true,
      lastWatermark: null
    })
  })

  it('reports incomplete with its watermark', () => {
    readCodexStateDbBackfillStatusMock.mockReturnValue({
      kind: 'incomplete',
      stateDbPath: '/x/state_5.sqlite',
      status: 'running',
      lastWatermark: 'sessions/2026/07/25/rollout-a.jsonl'
    })
    isCodexBackfillIndexPendingMock.mockReturnValue(true)
    expect(evaluateCodexBackfillHoldPoll('/x')).toEqual({
      pending: true,
      unreadable: false,
      lastWatermark: 'sessions/2026/07/25/rollout-a.jsonl'
    })
  })

  it('reports complete as not pending', () => {
    readCodexStateDbBackfillStatusMock.mockReturnValue({
      kind: 'complete',
      stateDbPath: '/x/state_5.sqlite'
    })
    isCodexBackfillIndexPendingMock.mockReturnValue(false)
    expect(evaluateCodexBackfillHoldPoll('/x')).toEqual({
      pending: false,
      unreadable: false,
      lastWatermark: null
    })
  })
})

describe('createCodexBackfillPaneHoldRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeHarness(results: CodexBackfillHoldPollResult[]) {
    const broadcasts: CodexBackfillPaneHoldState[] = []
    const release = vi.fn()
    const registry = createCodexBackfillPaneHoldRegistry({ broadcast: (s) => broadcasts.push(s) })
    let call = 0
    const evaluate = vi.fn(() => results[Math.min(call++, results.length - 1)])
    return { broadcasts, release, registry, evaluate }
  }

  const pendingResult: CodexBackfillHoldPollResult = {
    pending: true,
    unreadable: false,
    lastWatermark: 'sessions/2026/07/20/rollout-a.jsonl'
  }
  const doneResult: CodexBackfillHoldPollResult = {
    pending: false,
    unreadable: false,
    lastWatermark: null
  }

  it('broadcasts indexing immediately and exposes state via get()', () => {
    const h = makeHarness([pendingResult])
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    expect(h.broadcasts).toEqual([
      { paneKey: 'p1', phase: 'indexing', lastWatermark: 'sessions/2026/07/20/rollout-a.jsonl' }
    ])
    expect(h.registry.get('p1')).toEqual({
      paneKey: 'p1',
      phase: 'indexing',
      lastWatermark: 'sessions/2026/07/20/rollout-a.jsonl'
    })
    expect(h.release).not.toHaveBeenCalled()
  })

  it('releases on pending → false: broadcasts launched, delivers once, clears get()', () => {
    const h = makeHarness([pendingResult, doneResult])
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.broadcasts.at(-1)).toEqual({ paneKey: 'p1', phase: 'launched', lastWatermark: null })
    expect(h.registry.get('p1')).toBeNull()
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS * 3)
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('keeps holding across unreadable polls (active-writer contention)', () => {
    const unreadable: CodexBackfillHoldPollResult = {
      pending: true,
      unreadable: true,
      lastWatermark: null
    }
    const h = makeHarness([pendingResult, unreadable, unreadable, doneResult])
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS * 2)
    expect(h.release).not.toHaveBeenCalled()
    // Why: an unreadable poll must not clobber the last known watermark either.
    expect(h.registry.get('p1')?.lastWatermark).toBe('sessions/2026/07/20/rollout-a.jsonl')
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('re-broadcasts indexing when the watermark advances', () => {
    const advanced: CodexBackfillHoldPollResult = {
      pending: true,
      unreadable: false,
      lastWatermark: 'sessions/2026/07/25/rollout-b.jsonl'
    }
    const h = makeHarness([pendingResult, advanced])
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.broadcasts.at(-1)).toEqual({
      paneKey: 'p1',
      phase: 'indexing',
      lastWatermark: 'sessions/2026/07/25/rollout-b.jsonl'
    })
    expect(h.release).not.toHaveBeenCalled()
  })

  it('fails open at the max-wait ceiling while still pending', () => {
    const h = makeHarness([pendingResult])
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    vi.advanceTimersByTime(
      CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS + CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS
    )
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.broadcasts.at(-1)?.phase).toBe('launched')
  })

  it('dispose cancels without delivering or broadcasting further', () => {
    const h = makeHarness([pendingResult, doneResult])
    const handle = h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    handle.dispose()
    const broadcastCount = h.broadcasts.length
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS * 5)
    expect(h.release).not.toHaveBeenCalled()
    expect(h.broadcasts.length).toBe(broadcastCount)
    expect(h.registry.get('p1')).toBeNull()
  })

  it('begin() for an already-held paneKey replaces the previous hold', () => {
    const h = makeHarness([pendingResult])
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    const secondRelease = vi.fn()
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: secondRelease,
      evaluate: () => doneResult
    })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.release).not.toHaveBeenCalled()
    expect(secondRelease).toHaveBeenCalledTimes(1)
  })

  it('disposeAll clears every hold silently', () => {
    const h = makeHarness([pendingResult])
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    h.registry.begin({
      paneKey: 'p2',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    h.registry.disposeAll()
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS * 5)
    expect(h.release).not.toHaveBeenCalled()
    expect(h.registry.get('p1')).toBeNull()
    expect(h.registry.get('p2')).toBeNull()
  })
})
