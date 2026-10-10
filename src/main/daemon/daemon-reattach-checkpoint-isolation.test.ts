import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { DaemonFileLog } from './daemon-file-log'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import { readTerminalHistoryCheckpoint } from './terminal-history-checkpoint-reader'
import type { HistoryCheckpointResult } from './terminal-history-manager-options'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalSnapshot } from './types'

const REATTACH_BUDGET_MS = 2_000
// Why above DURABLE_HISTORY_OVERLAY_DEADLINE_MS: this asserts the reattach gives up on its own
// stalled checkpoint, so the window must outlast the deadline it is proving.
const DEADLINE_BUDGET_MS = 20_000
const scheduleBudgetTimeout = setTimeout
const clearBudgetTimeout = clearTimeout

function createMockSubprocess(): SubprocessHandle & { emitData: (data: string) => void } {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 4242,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExit?.(0), 1)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData(callback) {
      onData = callback
    },
    onExit(callback) {
      onExit = callback
    },
    dispose: vi.fn(),
    emitData(data) {
      onData?.(data)
    }
  }
}

/** Resolves 'timed-out' instead of hanging, so a wedged reattach fails the test rather than the run. */
async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | 'timed-out'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timed-out'>((resolve) => {
    timer = scheduleBudgetTimeout(() => resolve('timed-out'), budgetMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearBudgetTimeout(timer)
  }
}

describe('STA-4173 reattach isolation from a stalled checkpoint', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let subprocesses: ReturnType<typeof createMockSubprocess>[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattach-isolation-'))
    subprocesses = []
    const log: DaemonFileLog = { log: () => {}, close: () => {} }
    server = new DaemonServer({
      socketPath: getDaemonSocketPath(dir),
      tokenPath: join(dir, 'test.token'),
      log,
      spawnSubprocess: () => {
        const subprocess = createMockSubprocess()
        subprocesses.push(subprocess)
        return subprocess
      }
    })
    await server.start()
    adapter = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(dir),
      tokenPath: join(dir, 'test.token'),
      historyPath: join(dir, 'history')
    })
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Wedges one session's checkpoint at the history-write layer and reports how many times that
   * stall was actually entered, so a swallowed TypeError cannot masquerade as a stall.
   */
  async function stallCheckpointFor(stalledSessionId: string): Promise<{
    entered: () => number
    enteredPromise: Promise<void>
    completedPromise: Promise<HistoryCheckpointResult>
    release: () => void
  }> {
    const manager = adapter.getHistoryManager()
    expect(manager).not.toBeNull()
    const original = manager!.checkpoint.bind(manager!)
    let entered = 0
    let resolveEntered = (): void => {}
    const enteredPromise = new Promise<void>((resolve) => {
      resolveEntered = resolve
    })
    let resolveCompleted: (result: HistoryCheckpointResult) => void = () => {}
    const completedPromise = new Promise<HistoryCheckpointResult>((resolve) => {
      resolveCompleted = resolve
    })
    let release = (): void => {}
    const stalled = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(manager!, 'checkpoint').mockImplementation(
      async (
        sessionId: string,
        snapshot: TerminalSnapshot,
        opts?: { pendingOutputSeq?: number }
      ): Promise<HistoryCheckpointResult> => {
        if (sessionId !== stalledSessionId) {
          return await original(sessionId, snapshot, opts)
        }
        entered += 1
        resolveEntered()
        await stalled
        const result = await original(sessionId, snapshot, opts)
        resolveCompleted(result)
        return result
      }
    )
    return { entered: () => entered, enteredPromise, completedPromise, release }
  }

  async function spawnWithOutput(sessionId: string, output: string): Promise<string> {
    const { id } = await adapter.spawn({ cols: 80, rows: 24, sessionId, cwd: '/tmp' })
    subprocesses.at(-1)!.emitData(output)
    return id
  }

  it('reattaches an unrelated session while another session checkpoint never settles', async () => {
    const stalledId = await spawnWithOutput('stalled-session', 'STALLED_OUTPUT\r\n')
    const healthyId = await spawnWithOutput('healthy-session', 'HEALTHY_OUTPUT\r\n')
    const stall = await stallCheckpointFor(stalledId)

    // Why start the stalled reattach first: it is the one that parks a checkpoint, and before the
    // per-session queue that parked checkpoint owned the process-wide tail every reattach joined.
    const stalledReattach = adapter.spawn({ cols: 80, rows: 24, sessionId: stalledId, cwd: '/tmp' })
    void stalledReattach.catch(() => {})
    await vi.waitFor(() => expect(stall.entered()).toBeGreaterThan(0))

    const healthyReattach = await withinBudget(
      adapter.spawn({ cols: 80, rows: 24, sessionId: healthyId, cwd: '/tmp' }),
      REATTACH_BUDGET_MS
    )

    expect(healthyReattach).not.toBe('timed-out')
    expect(healthyReattach).toMatchObject({ isReattach: true })
    expect((healthyReattach as { snapshot: string }).snapshot).toContain('HEALTHY_OUTPUT')
    // The stall must still be parked, or the healthy reattach proved nothing.
    expect(stall.entered()).toBe(1)
    stall.release()
    await stalledReattach
  })

  it('falls back to the live window when the session own checkpoint blows the deadline', async () => {
    const stalledId = await spawnWithOutput('deadline-session', 'DEADLINE_OUTPUT\r\n')
    const stall = await stallCheckpointFor(stalledId)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
      const pendingReattach = withinBudget(
        adapter.spawn({ cols: 80, rows: 24, sessionId: stalledId, cwd: '/tmp' }),
        DEADLINE_BUDGET_MS
      )
      let settled = false
      void pendingReattach.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      const checkpointEntry = await withinBudget(
        Promise.race([
          stall.enteredPromise.then(() => 'entered' as const),
          pendingReattach.then(() => 'reattach-settled' as const)
        ]),
        DEADLINE_BUDGET_MS
      )
      expect(checkpointEntry, 'Reattach must enter its checkpoint before settling').toBe('entered')
      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).toBe(false)
      expect(warn).not.toHaveBeenCalledWith(
        '[history] durable snapshot overlay deadline exceeded:',
        stalledId
      )
      await vi.advanceTimersByTimeAsync(1)
      const reattach = await pendingReattach

      expect(stall.entered()).toBeGreaterThan(0)
      expect(reattach).not.toBe('timed-out')
      expect(reattach).toMatchObject({ isReattach: true })
      // Degraded to the daemon's live window, not empty: the deadline costs restore depth, not history.
      expect((reattach as { snapshot: string }).snapshot).toContain('DEADLINE_OUTPUT')
      expect(warn).toHaveBeenCalledWith(
        '[history] durable snapshot overlay deadline exceeded:',
        stalledId
      )
    } finally {
      vi.useRealTimers()
      stall.release()
      warn.mockRestore()
    }
  }, 30_000)

  it('bounds overlay compacts across distinct sessions without blocking reattach', async () => {
    const stalledIds = ['fanout-a', 'fanout-b', 'fanout-c', 'fanout-d']
    for (const sessionId of stalledIds) {
      await spawnWithOutput(sessionId, `${sessionId.toUpperCase()}\r\n`)
    }
    const overflowId = await spawnWithOutput('fanout-overflow', 'FANOUT_OVERFLOW\r\n')
    const manager = adapter.getHistoryManager()!
    const original = manager.checkpoint.bind(manager)
    const entered = new Set<string>()
    const checkpointed: string[] = []
    let release = (): void => {}
    const stalled = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(manager, 'checkpoint').mockImplementation(async (sessionId, snapshot, opts) => {
      checkpointed.push(sessionId)
      if (stalledIds.includes(sessionId)) {
        entered.add(sessionId)
        await stalled
      }
      return await original(sessionId, snapshot, opts)
    })

    const reattaches = stalledIds.map((sessionId) =>
      adapter.spawn({ cols: 80, rows: 24, sessionId, cwd: '/tmp' })
    )
    try {
      await vi.waitFor(() => expect(entered.size).toBe(stalledIds.length))

      const overflowReattach = await withinBudget(
        adapter.spawn({ cols: 80, rows: 24, sessionId: overflowId, cwd: '/tmp' }),
        REATTACH_BUDGET_MS
      )
      expect(overflowReattach).not.toBe('timed-out')
      expect(overflowReattach).toMatchObject({ isReattach: true })
      expect((overflowReattach as { snapshot: string }).snapshot).toContain('FANOUT_OVERFLOW')
      expect(checkpointed).not.toContain(overflowId)
    } finally {
      release()
      await Promise.allSettled(reattaches)
    }
  })

  it('still commits the abandoned checkpoint once the history write completes', async () => {
    const stalledId = await spawnWithOutput('resumed-session', 'RESUMED_OUTPUT\r\n')
    const stall = await stallCheckpointFor(stalledId)

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
      const pendingReattach = withinBudget(
        adapter.spawn({ cols: 80, rows: 24, sessionId: stalledId, cwd: '/tmp' }),
        DEADLINE_BUDGET_MS
      )
      let settled = false
      void pendingReattach.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      const checkpointEntry = await withinBudget(
        Promise.race([
          stall.enteredPromise.then(() => 'entered' as const),
          pendingReattach.then(() => 'reattach-settled' as const)
        ]),
        DEADLINE_BUDGET_MS
      )
      expect(checkpointEntry, 'Reattach must enter its checkpoint before settling').toBe('entered')
      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const reattach = await pendingReattach
      expect(reattach).not.toBe('timed-out')
    } finally {
      vi.useRealTimers()
      stall.release()
    }
    expect(await withinBudget(stall.completedPromise, DEADLINE_BUDGET_MS)).toBe('committed')
    const checkpointRead = await readTerminalHistoryCheckpoint(
      join(dir, 'history', getHistorySessionDirName(stalledId), 'checkpoint.json')
    )
    if (checkpointRead.status !== 'readable') {
      throw new Error(`Abandoned checkpoint is ${checkpointRead.status}`)
    }
    expect(
      `${checkpointRead.checkpoint.scrollbackAnsi}${checkpointRead.checkpoint.snapshotAnsi}`
    ).toContain('RESUMED_OUTPUT')
    // Why this is the whole point of not cancelling: the reattach degraded, and the durable write
    // the deadline walked away from still lands on disk for the next restore.
    await vi.waitFor(async () => {
      const restore = await new HistoryReader(join(dir, 'history')).detectColdRestore(stalledId, {
        ignoreCleanEnd: true
      })
      expect(`${restore?.scrollbackAnsi ?? ''}${restore?.snapshotAnsi ?? ''}`).toContain(
        'RESUMED_OUTPUT'
      )
    })
  }, 30_000)
})
