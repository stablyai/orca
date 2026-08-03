import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeSqliteCandidatePhase } from './session-scanner-opencode-sqlite-candidate-phase'
import { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import {
  resetSessionParseCacheForTests,
  seedSessionParseCache
} from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'

function candidate(path: string): SessionFileCandidate {
  return {
    agent: 'opencode',
    codexHome: null,
    file: { path, mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
  }
}

function phaseFor(
  candidates: readonly SessionFileCandidate[],
  context: OpenCodeSqliteScanContext
): OpenCodeSqliteCandidatePhase {
  return new OpenCodeSqliteCandidatePhase({ candidates, platform: 'darwin', context })
}

afterEach(() => {
  resetSessionParseCacheForTests()
})

describe('OpenCodeSqliteCandidatePhase', () => {
  it('filters terminated SQLite candidates before parsing but keeps legacy files', () => {
    const context = new OpenCodeSqliteScanContext()
    const sqlite = candidate('/data/opencode.db#session')
    const legacy = candidate('/data/storage/session/session.json')
    try {
      context.tripCircuit(new Error('test circuit'))
      const phase = phaseFor([sqlite, legacy], context)

      expect(phase.prepareBatch([sqlite, legacy])).toEqual([legacy])
      expect(context.metrics().workOmitted).toBe(true)
    } finally {
      context.dispose()
    }
  })

  it('keeps terminated SQLite candidates that the parse cache can still serve', () => {
    const context = new OpenCodeSqliteScanContext()
    const cached = candidate('/data/opencode.db#cached')
    const uncached = candidate('/data/opencode.db#uncached')
    seedSessionParseCache([
      [cached.file.path, { mtimeMs: 1, sizeBytes: null, platform: 'darwin', session: null }]
    ])
    try {
      context.tripCircuit(new Error('test circuit'))
      const phase = phaseFor([cached, uncached], context)

      // Cache reuse needs no worker, so only the uncached row is omitted.
      expect(phase.prepareBatch([cached, uncached])).toEqual([cached])
      expect(context.metrics()).toMatchObject({ sqliteParseCacheHits: 1, workOmitted: true })
    } finally {
      context.dispose()
    }
  })

  it('spends the budget on SQLite batches only', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1_000)
    const sqlite = candidate('/data/opencode.db#session')
    const legacy = candidate('/data/storage/session/session.json')
    try {
      const phase = phaseFor([sqlite, legacy], context)

      // A batch of other-agent work runs long; the SQLite budget must not tick.
      phase.prepareBatch([legacy])
      phase.trackBatch([legacy], [Promise.resolve()])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(context.metrics().deadlineExpired).toBe(false)

      phase.prepareBatch([sqlite])
      phase.trackBatch([sqlite], [new Promise<void>(() => {})])
      await vi.advanceTimersByTimeAsync(999)
      expect(context.metrics().deadlineExpired).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(context.metrics().deadlineExpired).toBe(true)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('banks the unspent budget between SQLite batches', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1_000)
    const first = candidate('/data/opencode.db#first')
    const second = candidate('/data/opencode.db#second')
    try {
      const phase = phaseFor([first, second], context)

      let finishFirst: () => void = () => {}
      phase.prepareBatch([first])
      phase.trackBatch([first], [new Promise<void>((resolve) => (finishFirst = resolve))])
      await vi.advanceTimersByTimeAsync(400)
      finishFirst()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(context.metrics().deadlineExpired).toBe(false)

      // Only the 400ms actually spent on SQLite work is gone from the budget.
      phase.prepareBatch([second])
      phase.trackBatch([second], [new Promise<void>(() => {})])
      await vi.advanceTimersByTimeAsync(599)
      expect(context.metrics().deadlineExpired).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(context.metrics().deadlineExpired).toBe(true)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('disarms immediately when discovery has no SQLite candidates', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      phaseFor([candidate('/legacy/session.json')], context)
      context.armDeadline()
      await vi.advanceTimersByTimeAsync(10)
      expect(context.metrics().deadlineExpired).toBe(false)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('disarms after the last SQLite promise without awaiting an unrelated parser', async () => {
    vi.useFakeTimers()
    const sqlite = candidate('/data/opencode.db#session')
    const legacy = candidate('/legacy/session.json')
    const completedContext = new OpenCodeSqliteScanContext(1)
    const stoppedContext = new OpenCodeSqliteScanContext(1)
    try {
      const completed = phaseFor([sqlite, legacy], completedContext)
      const batch = completed.prepareBatch([sqlite, legacy])
      const neverSettles = new Promise<void>(() => {})
      completed.trackBatch(batch, [Promise.resolve(), neverSettles])
      await Promise.resolve()

      const stopped = phaseFor([sqlite], stoppedContext)
      stopped.finish()
      stoppedContext.armDeadline()
      await vi.advanceTimersByTimeAsync(10)
      expect(completedContext.metrics().deadlineExpired).toBe(false)
      expect(stoppedContext.metrics().deadlineExpired).toBe(false)
    } finally {
      completedContext.dispose()
      stoppedContext.dispose()
      vi.useRealTimers()
    }
  })
})
