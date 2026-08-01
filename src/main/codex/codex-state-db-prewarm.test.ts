import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexStateDbBackfillStatus } from './codex-state-db'
import {
  PREWARM_FAST_EXIT_MS,
  PREWARM_MAX_SPAWNS,
  PREWARM_MIN_SESSION_FILES,
  PREWARM_POLL_INTERVAL_MS,
  PREWARM_SPAWN_RETRY_DELAY_MS,
  runCodexStateDbPrewarm,
  type CodexStateDbPrewarmDeps
} from './codex-state-db-prewarm'

type FakeChild = ChildProcess & { kill: ReturnType<typeof vi.fn> }

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.kill = vi.fn(() => true)
  return child
}

const incomplete: CodexStateDbBackfillStatus = {
  kind: 'incomplete',
  stateDbPath: '/tmp/home/state_5.sqlite',
  status: 'running',
  lastWatermark: null
}
const complete: CodexStateDbBackfillStatus = {
  kind: 'complete',
  stateDbPath: '/tmp/home/state_5.sqlite'
}

function createDeps(overrides: Partial<CodexStateDbPrewarmDeps> = {}): {
  deps: Partial<CodexStateDbPrewarmDeps>
  children: FakeChild[]
  spawnProcess: ReturnType<typeof vi.fn>
} {
  const children: FakeChild[] = []
  const spawnProcess = vi.fn(() => {
    const child = createFakeChild()
    children.push(child)
    return child
  })
  const deps: Partial<CodexStateDbPrewarmDeps> = {
    resolveCommand: () => 'codex',
    spawnProcess: spawnProcess as unknown as CodexStateDbPrewarmDeps['spawnProcess'],
    readBackfillStatus: vi.fn(() => incomplete),
    countSessionFiles: vi.fn(() => PREWARM_MIN_SESSION_FILES),
    logger: { warn: vi.fn(), info: vi.fn() },
    // Why inject now/sleep: the implementation's defaultDeps capture the NATIVE Date.now
    // reference at module load, which vi.useFakeTimers() (installed in beforeEach) does
    // NOT replace — leaving default now() on the real wall clock while the tests advance
    // a fake one. These call-time wrappers read the faked globalThis.Date/setTimeout, so
    // the fake clock governs both elapsed-time measurement and every wait.
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ...overrides
  }
  return { deps, children, spawnProcess }
}

beforeEach(() => {
  vi.useFakeTimers()
})

describe('runCodexStateDbPrewarm', () => {
  it('skips without spawning when the index is already complete', async () => {
    const { deps, spawnProcess } = createDeps({ readBackfillStatus: vi.fn(() => complete) })
    const result = await runCodexStateDbPrewarm('/tmp/home', {}, deps)
    expect(result.outcome).toBe('already-complete')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('skips when there is no state db and the session history is small', async () => {
    const { deps, spawnProcess } = createDeps({
      readBackfillStatus: vi.fn(() => ({ kind: 'missing' }) as CodexStateDbBackfillStatus),
      countSessionFiles: vi.fn(() => 3)
    })
    const result = await runCodexStateDbPrewarm('/tmp/home', {}, deps)
    expect(result.outcome).toBe('not-needed')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('spawns over a not-tracked state db with a large history (#11828 deadlock fix)', async () => {
    // Why: isCodexBackfillIndexPending calls not-tracked+large "pending"; the
    // prewarm must agree or the deferral/gate could never clear.
    const statuses: CodexStateDbBackfillStatus[] = [
      { kind: 'not-tracked', stateDbPath: '/x/state_5.sqlite' }
    ]
    const { deps, spawnProcess } = createDeps({
      readBackfillStatus: vi.fn(() => statuses.shift() ?? complete),
      countSessionFiles: vi.fn(() => PREWARM_MIN_SESSION_FILES)
    })
    const task = runCodexStateDbPrewarm('/x', {}, deps)
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    const result = await task
    expect(result.outcome).toBe('completed')
    expect(spawnProcess).toHaveBeenCalled()
  })

  it('reports not-needed for a not-tracked state db over a small history', async () => {
    const { deps, spawnProcess } = createDeps({
      readBackfillStatus: vi.fn(
        () =>
          ({ kind: 'not-tracked', stateDbPath: '/x/state_5.sqlite' }) as CodexStateDbBackfillStatus
      ),
      countSessionFiles: vi.fn(() => PREWARM_MIN_SESSION_FILES - 1)
    })
    const summary = await runCodexStateDbPrewarm('/x', {}, deps)
    expect(summary.outcome).toBe('not-needed')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('skips with a warning when the state db is unreadable', async () => {
    const warn = vi.fn()
    const { deps, spawnProcess } = createDeps({
      readBackfillStatus: vi.fn(
        () =>
          ({
            kind: 'unreadable',
            stateDbPath: '/tmp/home/state_5.sqlite',
            error: 'locked'
          }) as CodexStateDbBackfillStatus
      ),
      logger: { warn, info: vi.fn() }
    })
    const result = await runCodexStateDbPrewarm('/tmp/home', {}, deps)
    expect(result.outcome).toBe('skipped-unreadable')
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('supervises a codex child until the status flips to complete, then kills it', async () => {
    const statuses = [incomplete, incomplete, incomplete, complete]
    const readBackfillStatus = vi.fn(() => statuses.shift() ?? complete)
    const { deps, children } = createDeps({ readBackfillStatus })
    const task = runCodexStateDbPrewarm('/tmp/home', {}, deps)
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS * 4)
    const result = await task
    expect(result.outcome).toBe('completed')
    expect(result.spawnCount).toBe(1)
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('spawns and supervises past a stale running lease left by a killed codex (#11828)', async () => {
    // Why: the previous E2E proved a killed 10s trust-grant codex leaves
    // backfill_state = 'running'; the prewarm must treat that as incomplete and
    // spawn anyway (codex adopts idle indexes; stale leases expire <=15 min).
    const statuses: CodexStateDbBackfillStatus[] = [
      {
        kind: 'incomplete',
        stateDbPath: '/x/state_5.sqlite',
        status: 'running',
        lastWatermark: null
      },
      {
        kind: 'incomplete',
        stateDbPath: '/x/state_5.sqlite',
        status: 'running',
        lastWatermark: null
      },
      { kind: 'complete', stateDbPath: '/x/state_5.sqlite' }
    ]
    const readBackfillStatus = vi.fn(() => statuses.shift() ?? complete)
    const { deps, spawnProcess } = createDeps({ readBackfillStatus })

    const summaryPromise = runCodexStateDbPrewarm('/x', {}, deps)
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS * 3)

    const summary = await summaryPromise
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(summary.outcome).toBe('completed')
  })

  it('respawns on fast child deaths and gives up after the fast-failure budget', async () => {
    const { deps, children, spawnProcess } = createDeps()
    const task = runCodexStateDbPrewarm('/tmp/home', {}, deps)
    for (let i = 0; i < PREWARM_MAX_SPAWNS; i += 1) {
      // Why one poll then exit: the exit event lands 5s (one PREWARM_POLL_INTERVAL_MS)
      // after spawn — under the 10s PREWARM_FAST_EXIT_MS threshold — so each death is a
      // fast failure and must burn the budget.
      await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
      children.at(-1)?.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(PREWARM_SPAWN_RETRY_DELAY_MS + PREWARM_POLL_INTERVAL_MS)
    }
    const result = await task
    expect(result.outcome).toBe('gave-up')
    expect(spawnProcess).toHaveBeenCalledTimes(PREWARM_MAX_SPAWNS)
  })

  it('treats ~30s claim-blocked exits as expected and keeps respawning past the budget', async () => {
    // Why: verified codex 0.146 behavior — a non-claimant app-server exits ~30s after
    // start (foreign or stale backfill lease, self-healing within 900s); such exits
    // must NOT count toward PREWARM_MAX_SPAWNS.
    const statuses: CodexStateDbBackfillStatus[] = []
    const readBackfillStatus = vi.fn(() => statuses.shift() ?? incomplete)
    const { deps, children, spawnProcess } = createDeps({ readBackfillStatus })
    const task = runCodexStateDbPrewarm('/tmp/home', {}, deps)
    for (let i = 0; i < PREWARM_MAX_SPAWNS + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(PREWARM_FAST_EXIT_MS * 3)
      children.at(-1)?.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(PREWARM_SPAWN_RETRY_DELAY_MS)
    }
    expect(spawnProcess.mock.calls.length).toBeGreaterThan(PREWARM_MAX_SPAWNS)
    statuses.push(complete)
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    const result = await task
    expect(result.outcome).toBe('completed')
  })

  it('stops and kills the child when shouldStop flips true', async () => {
    const { deps, children } = createDeps()
    let stop = false
    const task = runCodexStateDbPrewarm('/tmp/home', { shouldStop: () => stop }, deps)
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    stop = true
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    const result = await task
    expect(result.outcome).toBe('stopped')
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('reports codex-unavailable when the first spawn errors (ENOENT)', async () => {
    const { deps, children } = createDeps()
    const task = runCodexStateDbPrewarm('/tmp/home', {}, deps)
    await vi.advanceTimersByTimeAsync(0)
    children[0].emit('error', new Error('spawn codex ENOENT'))
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    const result = await task
    expect(result.outcome).toBe('codex-unavailable')
  })
})
