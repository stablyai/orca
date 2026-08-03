import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OpenCodeSqliteWorkerClient,
  PARSE_TIMEOUT_MS
} from './session-scanner-opencode-sqlite-worker-client'
import {
  MAX_CONSECUTIVE_TIMEOUTS,
  MAX_CONSECUTIVE_UNAVAILABLE,
  TERMINATE_GRACE_MS
} from './session-scanner-opencode-sqlite-worker-transport'
import type { OpenCodeSqliteWorkerRequest } from './session-scanner-opencode-sqlite-worker-protocol'
import type { ActiveSpan } from '../observability/tracer'
import { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import {
  openCodeSqliteScanCooldownRemainingMs,
  resetOpenCodeSqliteScanCooldownForTests
} from './session-scanner-opencode-sqlite-scan-cooldown'
import { recordOpenCodeSqliteScanOutcome } from './session-scanner-opencode-sqlite-scan-outcome'

// A worker_threads stand-in that records posted requests and never answers.
// Enough to drive the transport without a built worker bundle.
class SilentWorker {
  postedRequests: OpenCodeSqliteWorkerRequest[] = []
  private listeners = new Map<string, Set<(arg?: unknown) => void>>()

  on(event: string, listener: (arg?: unknown) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, listener: (arg?: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  unref(): void {}

  async terminate(): Promise<number> {
    return 1
  }

  postMessage(request: OpenCodeSqliteWorkerRequest): void {
    this.postedRequests.push(request)
  }
}

function makeFactory(workers: SilentWorker[]): () => Worker {
  return () => {
    const worker = new SilentWorker()
    workers.push(worker)
    return worker as unknown as Worker
  }
}

function noopSpan(): ActiveSpan {
  return {
    traceId: 'trace',
    spanId: 'span',
    setAttribute() {},
    addEvent() {},
    fail() {},
    interrupt() {},
    end() {}
  }
}

// The budget clock is armed by the scan phases, not by construction.
function armedScanContext(): OpenCodeSqliteScanContext {
  const scanContext = new OpenCodeSqliteScanContext()
  scanContext.armDeadline()
  return scanContext
}

beforeEach(() => {
  resetOpenCodeSqliteScanCooldownForTests()
})

afterEach(() => {
  resetOpenCodeSqliteScanCooldownForTests()
})

// Why: this scan re-runs every cache TTL, so work that cannot succeed must stop
// being retried. Both circuits below arm the process-wide backoff, and both must
// terminate the scan — a scan that reads as clean clears the backoff it armed.
describe('OpenCode SQLite worker backoff circuits', () => {
  // Why: a worker that cannot spawn fails instantly, so retrying it once per
  // candidate re-burns the same doomed work for a whole 1000-row scan. It must
  // give up, and the give-up must survive end-of-scan bookkeeping — otherwise
  // the scan reads as clean and clears the backoff it just armed.
  it('gives up on a scan whose worker never spawns and keeps the backoff armed', async () => {
    resetOpenCodeSqliteScanCooldownForTests()
    let spawnAttempts = 0
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory: () => {
        spawnAttempts += 1
        throw new Error('no worker bundle')
      },
      log() {}
    })
    const scanContext = armedScanContext()

    try {
      for (let call = 0; call < MAX_CONSECUTIVE_UNAVAILABLE + 5; call += 1) {
        await expect(
          client.parse({
            context: scanContext,
            dbPath: '/db',
            sessionId: `s${call}`,
            platform: 'darwin'
          })
        ).rejects.toThrow()
      }

      expect(spawnAttempts).toBe(MAX_CONSECUTIVE_UNAVAILABLE)
      expect(scanContext.metrics().terminationReason).toBe('workerUnavailable')

      // End-of-scan bookkeeping must not read this as a clean run.
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context: scanContext,
        discoveries: [],
        issues: [],
        span: noopSpan()
      })
      expect(openCodeSqliteScanCooldownRemainingMs()).toBeGreaterThan(0)
    } finally {
      scanContext.dispose()
      resetOpenCodeSqliteScanCooldownForTests()
    }
  })

  // Why: each timeout also costs a terminate grace period before the next call
  // can dispatch. If that total outlasts the scan deadline the timeout circuit
  // can never trip, and a permanently-slow database is misreported as a budget
  // expiry — which by design does not back off, so it re-burns every scan.
  it('trips the timeout circuit before the scan deadline can preempt it', async () => {
    vi.useFakeTimers()
    resetOpenCodeSqliteScanCooldownForTests()
    const workers: SilentWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const scanContext = armedScanContext()

    try {
      const calls = Array.from({ length: MAX_CONSECUTIVE_TIMEOUTS + 2 }, (_, index) =>
        client
          .parse({
            context: scanContext,
            dbPath: '/db',
            sessionId: `s${index}`,
            platform: 'darwin'
          })
          .catch(() => 'rejected')
      )

      // Never answer: every dispatched call times out, each followed by the
      // terminate grace period before the next one can start.
      await vi.advanceTimersByTimeAsync(
        MAX_CONSECUTIVE_TIMEOUTS * (PARSE_TIMEOUT_MS + TERMINATE_GRACE_MS) + 1
      )
      await Promise.all(calls)

      expect(scanContext.metrics().terminationReason).toBe('workerTimeoutLoop')
      expect(scanContext.metrics().deadlineExpired).toBe(false)
      expect(openCodeSqliteScanCooldownRemainingMs()).toBeGreaterThan(0)
    } finally {
      scanContext.dispose()
      resetOpenCodeSqliteScanCooldownForTests()
      vi.useRealTimers()
    }
  })
})
