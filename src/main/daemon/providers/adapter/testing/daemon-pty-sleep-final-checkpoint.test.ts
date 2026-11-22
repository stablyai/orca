import { describe, expect, it } from 'vitest'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import {
  FinalCheckpointNotCommittedError,
  FinalCheckpointWaitExpiredError
} from '../daemon-pty-lifecycle-errors'
import {
  mapHistoryCheckpointResult,
  type CheckpointWriteResult
} from '../../checkpointing/daemon-pty-checkpoint-result'
import type { ColdRestorePayload } from '../../../history/restoration/cold-restore-payload-cache'

/**
 * The adapter's dependency seams are protected. Tests patch only what the Sleep decision reads;
 * the production `shutdown` / `shutdownWithHistoryLock` bodies run unchanged.
 */
type AdapterSeams = {
  client: {
    request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  }
  historyManager: {
    checkpoint: (sessionId: string, snapshot: unknown) => Promise<string>
    suspendSession: (sessionId: string) => void
  } | null
  historyReader: {
    detectColdRestoreState: (sessionId: string, opts?: unknown) => Promise<unknown>
  } | null
  supportsIncrementalCheckpoints: boolean
  activeSessionIds: Set<string>
  coldRestoreCache: { has: (sessionId: string) => boolean }
  sleepRestoreSessionIds: Set<string>
  ensureConnected: (deadlineMs?: number) => Promise<void>
  adoptListedSessionForSleep: (sessionId: string, deadlineMs?: number) => Promise<void>
  withHistorySpawnLock: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>
  runExclusiveCheckpoint: (
    operation: () => Promise<void>,
    options?: { callerDeadlineMs?: number }
  ) => Promise<boolean>
  checkpointSessions: (
    sessionIds: Iterable<string>,
    opts?: { final?: boolean; teardown?: boolean }
  ) => Promise<Set<string>>
  completeShutdownWithHistoryLock: (
    sessionId: string,
    opts: { keepHistory?: boolean }
  ) => Promise<void>
  buildColdRestorePayload: (restoreInfo: unknown) => ColdRestorePayload | null
  takeSnapshotAndCheckpoint: (
    sessionId: string,
    opts: unknown
  ) => Promise<{ checkpoint: 'committed' | 'retryable' | 'unavailable'; snapshot: null }>
  writeSessionCheckpoint: (
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ) => Promise<CheckpointWriteResult>
  shutdown: (sessionId: string, opts: { keepHistory: boolean }) => Promise<void>
}

type Harness = {
  seams: AdapterSeams
  events: string[]
  killRequests: () => number
  detectCalls: () => number
  setCompleted: (committed: boolean) => void
  settlement: 'settled' | 'deadline'
  setDetector: (result: unknown) => void
  backgroundCheckpoint: Promise<void> | null
}

function createHarness(): Harness {
  const adapter = new DaemonPtyAdapter({
    socketPath: '/tmp/orca-exp2-test.sock',
    tokenPath: '/tmp/orca-exp2-test.token',
    profileScope: 'exp2-test'
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test replaces the adapter's protected dependency seams; production method bodies run unchanged.
  const seams = adapter as unknown as AdapterSeams
  const events: string[] = []
  let completed = new Set<string>()
  let detectCalls = 0
  let killRequests = 0
  let detectorResult: unknown = {
    status: 'restored',
    restoreInfo: { cwd: '/tmp/orca-exp2-worktree', cols: 80, rows: 24 }
  }
  let backgroundCheckpoint: Promise<void> | null = null

  const harness: Harness = {
    seams,
    events,
    killRequests: () => killRequests,
    detectCalls: () => detectCalls,
    setCompleted: (committed) => {
      completed = committed ? new Set(['session-1']) : new Set()
    },
    settlement: 'settled',
    setDetector: (result) => {
      detectorResult = result
    },
    backgroundCheckpoint: null
  }

  seams.client = {
    request: async (method) => {
      if (method === 'kill') {
        killRequests += 1
        events.push('kill')
      }
      return undefined
    }
  }
  seams.historyManager = null
  seams.historyReader = {
    detectColdRestoreState: async () => {
      detectCalls += 1
      events.push('detect')
      return detectorResult
    }
  }
  seams.supportsIncrementalCheckpoints = true
  seams.ensureConnected = async () => {}
  seams.adoptListedSessionForSleep = async () => {}
  seams.withHistorySpawnLock = async (_sessionId, operation) => operation()
  seams.runExclusiveCheckpoint = async (operation) => {
    if (harness.settlement === 'deadline') {
      // The real seam keeps the checkpoint running after the caller deadline expires.
      backgroundCheckpoint = operation()
      harness.backgroundCheckpoint = backgroundCheckpoint
      return false
    }
    await operation()
    return true
  }
  seams.checkpointSessions = async () => {
    events.push('checkpoint')
    return completed
  }
  seams.completeShutdownWithHistoryLock = async () => {
    events.push('complete')
  }
  seams.buildColdRestorePayload = () =>
    ({
      scrollback: 'older-recovery-screen',
      cwd: '/tmp/orca-exp2-worktree',
      cols: 80,
      rows: 24
    }) satisfies ColdRestorePayload
  return harness
}

const SESSION_ID = 'session-1'

describe('Sleep final checkpoint commit gate (#46691)', () => {
  it('keeps the live terminal when the final checkpoint is retryable (deferred)', async () => {
    const harness = createHarness()
    harness.setCompleted(false)

    await expect(invokeSleep(harness, SESSION_ID)).rejects.toBeInstanceOf(
      FinalCheckpointNotCommittedError
    )

    expect(harness.events).toEqual(['checkpoint'])
    expect(harness.killRequests()).toBe(0)
    expect(harness.detectCalls()).toBe(0)
    expect(harness.seams.coldRestoreCache.has(SESSION_ID)).toBe(false)
    expect(harness.seams.sleepRestoreSessionIds.has(SESSION_ID)).toBe(false)
  })

  it('keeps the live terminal when checkpoint publication is unavailable', async () => {
    const harness = createHarness()
    harness.setCompleted(false)

    await expect(invokeSleep(harness, SESSION_ID)).rejects.toBeInstanceOf(
      FinalCheckpointNotCommittedError
    )

    expect(harness.killRequests()).toBe(0)
    expect(harness.detectCalls()).toBe(0)
    expect(harness.seams.coldRestoreCache.has(SESSION_ID)).toBe(false)
  })

  it('keeps the live terminal when the final snapshot is unavailable', async () => {
    const harness = createHarness()
    harness.setCompleted(false)

    await expect(invokeSleep(harness, SESSION_ID)).rejects.toBeInstanceOf(
      FinalCheckpointNotCommittedError
    )

    expect(harness.killRequests()).toBe(0)
    expect(harness.events).toEqual(['checkpoint'])
    expect(harness.seams.coldRestoreCache.has(SESSION_ID)).toBe(false)
  })

  it('reads the newest recovery, then kills, when the final checkpoint committed', async () => {
    const harness = createHarness()
    harness.setCompleted(true)

    await invokeSleep(harness, SESSION_ID)

    expect(harness.events).toEqual(['checkpoint', 'detect', 'kill', 'complete'])
    expect(harness.killRequests()).toBe(1)
    expect(harness.seams.coldRestoreCache.has(SESSION_ID)).toBe(true)
    expect(harness.seams.sleepRestoreSessionIds.has(SESSION_ID)).toBe(true)
  })

  it('keeps the deadline path and lets the same checkpoint finish afterwards', async () => {
    const harness = createHarness()
    harness.setCompleted(true)
    harness.settlement = 'deadline'

    await expect(invokeSleep(harness, SESSION_ID)).rejects.toBeInstanceOf(
      FinalCheckpointWaitExpiredError
    )

    expect(harness.killRequests()).toBe(0)
    expect(harness.detectCalls()).toBe(0)
    await harness.backgroundCheckpoint
    expect(harness.events).toEqual(['checkpoint'])
  })
})

describe('checkpoint persistence result mapping (#46691)', () => {
  it.each([
    ['committed', 'done'],
    ['retryable', 'deferred'],
    ['unavailable', 'unavailable']
  ] as const)('maps %s to %s', (result, expected) => {
    expect(mapHistoryCheckpointResult(result)).toBe(expected)
  })

  it('maps an unavailable final snapshot to unavailable, never done', async () => {
    const harness = createHarness()
    harness.seams.takeSnapshotAndCheckpoint = async () => ({
      checkpoint: 'unavailable',
      snapshot: null
    })

    await expect(
      harness.seams.writeSessionCheckpoint(SESSION_ID, { final: true, teardown: true })
    ).resolves.toBe('unavailable')
  })

  it('maps an unavailable non-incremental checkpoint to unavailable, never done', async () => {
    const harness = createHarness()
    harness.seams.supportsIncrementalCheckpoints = false
    harness.seams.client = {
      request: async (method) =>
        method === 'getSnapshot' ? { snapshot: { marker: 'live' } } : undefined
    }
    harness.seams.historyManager = {
      checkpoint: async () => 'unavailable',
      suspendSession: () => {}
    }

    await expect(
      harness.seams.writeSessionCheckpoint(SESSION_ID, { final: false, teardown: false })
    ).resolves.toBe('unavailable')
  })
})

function invokeSleep(harness: Harness, sessionId: string): Promise<void> {
  return invokeShutdown(harness, sessionId)
}

function invokeShutdown(harness: Harness, sessionId: string): Promise<void> {
  // Production `shutdown`; the seams above replace its collaborators.
  return harness.seams.shutdown(sessionId, { keepHistory: true })
}
