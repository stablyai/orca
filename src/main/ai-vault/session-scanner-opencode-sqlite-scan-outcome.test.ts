import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveSpan } from '../observability/tracer'
import { recordOpenCodeSqliteScanOutcome } from './session-scanner-opencode-sqlite-scan-outcome'
import { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import {
  openCodeSqliteScanCooldownRemainingMs,
  resetOpenCodeSqliteScanCooldownForTests
} from './session-scanner-opencode-sqlite-scan-cooldown'

function recordingSpan(attributes: Map<string, unknown>): ActiveSpan {
  return {
    traceId: 'trace',
    spanId: 'span',
    setAttribute(key, value) {
      attributes.set(key, value)
    },
    addEvent() {},
    fail() {},
    interrupt() {},
    end() {}
  }
}

describe('recordOpenCodeSqliteScanOutcome', () => {
  beforeEach(() => {
    resetOpenCodeSqliteScanCooldownForTests()
  })

  afterEach(() => {
    resetOpenCodeSqliteScanCooldownForTests()
  })

  it('arms the process-wide backoff on a crash loop and clears it on a clean scan', () => {
    const crashed = new OpenCodeSqliteScanContext()
    try {
      crashed.tripCircuit(new Error('worker died'))
      expect(openCodeSqliteScanCooldownRemainingMs()).toBeGreaterThan(0)
    } finally {
      crashed.dispose()
    }

    // A budget expiry is not a hard failure: it still made cacheable progress.
    const clean = new OpenCodeSqliteScanContext()
    try {
      clean.markSqliteSourcePresent()
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context: clean,
        discoveries: [],
        issues: [],
        span: recordingSpan(new Map())
      })
      expect(openCodeSqliteScanCooldownRemainingMs()).toBe(0)
    } finally {
      clean.dispose()
    }
  })

  it('does not clear a prior failure when the scan had no SQLite source', () => {
    const failed = new OpenCodeSqliteScanContext()
    failed.tripCircuit(new Error('worker died'))
    failed.dispose()
    expect(openCodeSqliteScanCooldownRemainingMs()).toBeGreaterThan(0)

    const noSource = new OpenCodeSqliteScanContext()
    try {
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context: noSource,
        discoveries: [],
        issues: [],
        span: recordingSpan(new Map())
      })
      expect(openCodeSqliteScanCooldownRemainingMs()).toBeGreaterThan(0)
    } finally {
      noSource.dispose()
    }
  })

  it('reports omitted work once with tuning metrics', () => {
    const context = new OpenCodeSqliteScanContext()
    const attributes = new Map<string, unknown>()
    const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
    try {
      context.markWorkOmitted()
      context.markWorkOmitted()
      context.noteQueueWait(12)
      context.noteActiveWorker(34)

      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(attributes)
      })

      expect(issues).toHaveLength(1)
      expect(issues[0]?.message).toMatch(/Some OpenCode history was skipped/)
      expect(attributes.get('opencodeSqliteQueueWaitMs')).toBe(12)
      expect(attributes.get('opencodeSqliteActiveWorkerMs')).toBe(34)
    } finally {
      context.dispose()
    }
  })

  it('names the cause when a worker crash loop, not the budget, omitted work', () => {
    const context = new OpenCodeSqliteScanContext()
    const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
    try {
      context.tripCircuit(new Error('worker died'))
      context.markWorkOmitted()

      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(new Map())
      })

      expect(issues[0]?.message).toMatch(/kept crashing/)
    } finally {
      context.dispose()
    }
  })

  it('reports unreconciled legacy files when the SQLite listing was cancelled', () => {
    const context = new OpenCodeSqliteScanContext()
    const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
    try {
      context.markSqliteListCancelled()

      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(new Map())
      })

      expect(issues).toHaveLength(1)
      expect(issues[0]?.message).toMatch(/could not be checked against its SQLite database/)
    } finally {
      context.dispose()
    }
  })

  // Why: the cause is the actionable half. A cancelled listing is a consequence
  // of it, so it must not displace it in a single-issue report.
  it('leads with the termination cause when the listing was also cancelled', () => {
    const context = new OpenCodeSqliteScanContext()
    const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
    try {
      context.tripTimeoutCircuit(new Error('too slow'))
      context.markSqliteListCancelled()
      context.markWorkOmitted()

      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(new Map())
      })

      expect(issues).toHaveLength(1)
      expect(issues[0]?.message).toMatch(/^Some OpenCode history was skipped because its SQLite/)
      expect(issues[0]?.message).toMatch(/never checked/)
    } finally {
      context.dispose()
    }
  })

  it('explains the pause while the process-wide backoff holds', () => {
    const context = new OpenCodeSqliteScanContext()
    const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
    try {
      context.markSqliteSourcePresent()
      context.enterCooldown(120_000)

      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(new Map())
      })

      // Reported even with nothing omitted: it explains the absent SQLite half.
      expect(issues).toHaveLength(1)
      expect(issues[0]?.message).toMatch(/paused after repeated failures/)
    } finally {
      context.dispose()
    }
  })

  // Why: the backoff is process-wide and outlives the install that armed it.
  it('stays quiet about the pause when no OpenCode database exists', () => {
    const context = new OpenCodeSqliteScanContext()
    const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
    try {
      context.enterCooldown(120_000)

      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(new Map())
      })

      expect(issues).toEqual([])
    } finally {
      context.dispose()
    }
  })

  it('backs off when the whole budget elapsed with no parse response', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      context.armDeadline()
      await vi.advanceTimersByTimeAsync(1)
      context.markWorkOmitted()
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues: [],
        span: recordingSpan(new Map())
      })
      expect(context.metrics().workerAnswered).toBe(false)
      expect(openCodeSqliteScanCooldownRemainingMs()).toBeGreaterThan(0)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('does not mistake a list response for cacheable progress', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      context.noteWorkerResponse()
      context.armDeadline()
      await vi.advanceTimersByTimeAsync(1)
      context.markWorkOmitted()
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues: [],
        span: recordingSpan(new Map())
      })
      expect(context.metrics()).toMatchObject({ workerAnswered: true, parseAnswered: false })
      expect(openCodeSqliteScanCooldownRemainingMs()).toBeGreaterThan(0)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('does not back off when the budget expired after real progress', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      context.noteWorkerResponse()
      context.noteParseResponse()
      context.armDeadline()
      await vi.advanceTimersByTimeAsync(1)
      context.markWorkOmitted()
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues: [],
        span: recordingSpan(new Map())
      })
      expect(openCodeSqliteScanCooldownRemainingMs()).toBe(0)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('does not back off when the deadline scan served SQLite rows from parse cache', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      context.noteSqliteParseCacheHit()
      context.armDeadline()
      await vi.advanceTimersByTimeAsync(1)
      context.markWorkOmitted()
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues: [],
        span: recordingSpan(new Map())
      })
      expect(context.metrics()).toMatchObject({
        parseAnswered: false,
        sqliteParseCacheHits: 1
      })
      expect(openCodeSqliteScanCooldownRemainingMs()).toBe(0)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('does not report deadline expiry when no work was omitted', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      context.armDeadline()
      await vi.advanceTimersByTimeAsync(1)
      const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(new Map())
      })
      expect(context.metrics().deadlineExpired).toBe(true)
      expect(issues).toEqual([])
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('disarms the deadline before later non-SQLite scan work', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      context.disarmDeadline()
      // A retired budget stays retired even if a later leg tries to re-arm it.
      context.armDeadline()
      await vi.advanceTimersByTimeAsync(10)
      expect(context.isTerminated).toBe(false)
      expect(context.metrics().deadlineExpired).toBe(false)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })
})
