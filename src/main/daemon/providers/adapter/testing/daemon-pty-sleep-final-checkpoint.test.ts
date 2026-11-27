import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import {
  DegradedRestoreUnavailableError,
  FinalCheckpointNotCommittedError,
  FinalCheckpointWaitExpiredError
} from '../daemon-pty-lifecycle-errors'
import {
  mapHistoryCheckpointResult,
  type CheckpointWriteResult,
  type SettledCheckpointOutcome
} from '../../checkpointing/daemon-pty-checkpoint-result'
import type { ColdRestorePayload } from '../../../history/restoration/cold-restore-payload-cache'

/**
 * The adapter's dependency seams are protected. Tests patch only what the Sleep
 * decision and the checkpoint persistence read; production bodies run unchanged.
 */
type AdapterSeams = {
  client: {
    request: (
      method: string,
      params?: Record<string, unknown>,
      timeoutMs?: number
    ) => Promise<unknown>
  }
  historyManager: {
    checkpoint: (
      sessionId: string,
      snapshot: unknown,
      opts?: unknown
    ) => Promise<'committed' | 'retryable' | 'unavailable'>
    suspendSession: (sessionId: string) => void
    appendIncrements: (
      sessionId: string,
      seq: number,
      records: unknown[]
    ) => Promise<'ok' | 'needs-checkpoint'>
  } | null
  historyReader: {
    detectColdRestoreState: (sessionId: string, opts?: unknown) => Promise<unknown>
  } | null
  supportsIncrementalCheckpoints: boolean
  supportsCheckpoints: boolean
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
  ) => Promise<{
    settled: Map<string, SettledCheckpointOutcome>
    errors: Map<string, unknown>
  }>
  checkpointSession: (
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ) => Promise<CheckpointWriteResult>
  checkpointDirtySessions: () => Promise<void>
  dirtySessionVersions: Map<string, number>
  sessionsNeedingFullCheckpoint: Set<string>
  sessionsNeedingLiveCheckpoint: Set<string>
  sessionsNeedingContinuityCheckpoint: Set<string>
  lastFullCheckpointAt: Map<string, number>
  fullCheckpointBackoff: Map<string, { failedAt: number; streak: number }>
  checkpointTimer: ReturnType<typeof setTimeout> | null
  completeShutdownWithHistoryLock: (
    sessionId: string,
    opts: { keepHistory?: boolean }
  ) => Promise<void>
  buildColdRestorePayload: (restoreInfo: unknown) => ColdRestorePayload | null
  takeSnapshotAndCheckpoint: (
    sessionId: string,
    opts: unknown
  ) => Promise<{
    checkpoint: 'committed' | 'retryable' | 'unavailable' | 'no-snapshot'
    snapshot: null
  }>
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
  setOutcome: (outcome: SettledCheckpointOutcome | undefined) => void
  setError: (error: unknown) => void
  settlement: 'settled' | 'deadline'
  setDetector: (result: unknown) => void
  backgroundCheckpoint: Promise<void> | null
}

const SESSION_ID = 'session-1'

function createHarness(): Harness {
  const adapter = new DaemonPtyAdapter({
    socketPath: '/tmp/orca-exp2-test.sock',
    tokenPath: '/tmp/orca-exp2-test.token',
    profileScope: 'exp2-test'
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test replaces the adapter's protected dependency seams; production method bodies run unchanged.
  const seams = adapter as unknown as AdapterSeams
  const events: string[] = []
  let outcome: SettledCheckpointOutcome | undefined = 'committed'
  let error: unknown
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
    setOutcome: (next) => {
      outcome = next
    },
    setError: (next) => {
      error = next
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
  seams.historyManager = {
    checkpoint: async () => 'committed',
    suspendSession: () => {},
    appendIncrements: async () => 'ok'
  }
  seams.historyReader = {
    detectColdRestoreState: async () => {
      detectCalls += 1
      events.push('detect')
      return detectorResult
    }
  }
  seams.supportsIncrementalCheckpoints = true
  seams.supportsCheckpoints = false
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
    const settled = new Map<string, SettledCheckpointOutcome>()
    const errors = new Map<string, unknown>()
    if (outcome !== undefined) {
      settled.set(SESSION_ID, outcome)
    }
    if (error !== undefined) {
      errors.set(SESSION_ID, error)
    }
    return { settled, errors }
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

function invokeSleep(harness: Harness, sessionId: string): Promise<void> {
  // Production `shutdown`; the seams above replace its collaborators.
  return harness.seams.shutdown(sessionId, { keepHistory: true })
}

describe('Sleep final checkpoint gate (#46691 rev2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('T3: a deferred (retryable) final pass keeps the live terminal', async () => {
    const harness = createHarness()
    harness.setOutcome(undefined)

    await expect(invokeSleep(harness, SESSION_ID)).rejects.toBeInstanceOf(
      FinalCheckpointNotCommittedError
    )

    expect(harness.events).toEqual(['checkpoint'])
    expect(harness.killRequests()).toBe(0)
    expect(harness.detectCalls()).toBe(0)
    expect(harness.seams.coldRestoreCache.has(SESSION_ID)).toBe(false)
    expect(harness.seams.sleepRestoreSessionIds.has(SESSION_ID)).toBe(false)
  })

  it('T1: a permanently-unavailable final pass kills with a degraded warning', async () => {
    const harness = createHarness()
    harness.setOutcome('permanently-unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await invokeSleep(harness, SESSION_ID)

    expect(harness.killRequests()).toBe(1)
    expect(harness.events).toEqual(['checkpoint', 'detect', 'kill', 'complete'])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('degraded'),
      expect.objectContaining({ sessionId: SESSION_ID, degraded: true })
    )
  })

  it('T2: a no-snapshot final pass kills with a degraded warning (e.g. 16 MiB line cap)', async () => {
    const harness = createHarness()
    harness.setOutcome('no-snapshot')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await invokeSleep(harness, SESSION_ID)

    expect(harness.killRequests()).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('degraded'),
      expect.objectContaining({ degraded: true })
    )
  })

  it('allows a final pass whose transport error is NdjsonLineTooLongError', async () => {
    const harness = createHarness()
    harness.setOutcome(undefined)
    const { NdjsonLineTooLongError } =
      await import('../../../../../shared/json-stream/main-process-ndjson-framer')
    harness.setError(new NdjsonLineTooLongError(16 * 1024 * 1024 + 1, 16 * 1024 * 1024))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await invokeSleep(harness, SESSION_ID)

    expect(harness.killRequests()).toBe(1)
  })

  it('degrades when the daemon has no history manager at all', async () => {
    const harness = createHarness()
    harness.seams.historyManager = null
    harness.setOutcome(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await invokeSleep(harness, SESSION_ID)

    expect(harness.killRequests()).toBe(1)
  })

  it('T10: a degraded Sleep refuses to kill when no recovery is detectable', async () => {
    const harness = createHarness()
    harness.setOutcome('permanently-unavailable')
    harness.setDetector({ status: 'none' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(invokeSleep(harness, SESSION_ID)).rejects.toBeInstanceOf(
      DegradedRestoreUnavailableError
    )

    expect(harness.killRequests()).toBe(0)
    expect(harness.detectCalls()).toBe(1)
  })

  it('T11: a degraded Sleep refuses to kill when history is unreadable', async () => {
    const harness = createHarness()
    harness.setOutcome('no-snapshot')
    harness.setDetector({ status: 'unreadable' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(invokeSleep(harness, SESSION_ID)).rejects.toBeInstanceOf(
      DegradedRestoreUnavailableError
    )

    expect(harness.killRequests()).toBe(0)
  })

  it('T12: a degraded Sleep with restored history still kills', async () => {
    const harness = createHarness()
    harness.setOutcome('permanently-unavailable')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await invokeSleep(harness, SESSION_ID)

    expect(harness.killRequests()).toBe(1)
    expect(harness.seams.coldRestoreCache.has(SESSION_ID)).toBe(true)
  })

  it('T13: a degraded Sleep without a history reader refuses to kill', async () => {
    const harness = createHarness()
    harness.setOutcome('permanently-unavailable')
    harness.seams.historyReader = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(invokeSleep(harness, SESSION_ID)).rejects.toBeInstanceOf(
      DegradedRestoreUnavailableError
    )

    expect(harness.killRequests()).toBe(0)
  })

  it('committed Sleep is unaffected by an undetectable recovery', async () => {
    const harness = createHarness()
    harness.setOutcome('committed')
    harness.setDetector({ status: 'none' })

    await invokeSleep(harness, SESSION_ID)

    expect(harness.killRequests()).toBe(1)
  })

  it('reads the newest recovery, then kills, when the final checkpoint committed', async () => {
    const harness = createHarness()
    harness.setOutcome('committed')

    await invokeSleep(harness, SESSION_ID)

    expect(harness.events).toEqual(['checkpoint', 'detect', 'kill', 'complete'])
    expect(harness.killRequests()).toBe(1)
    expect(harness.seams.coldRestoreCache.has(SESSION_ID)).toBe(true)
    expect(harness.seams.sleepRestoreSessionIds.has(SESSION_ID)).toBe(true)
  })

  it('keeps the deadline path and lets the same checkpoint finish afterwards', async () => {
    const harness = createHarness()
    harness.setOutcome('committed')
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

describe('checkpoint persistence result mapping (#46691 rev2)', () => {
  it.each([
    ['committed', 'committed'],
    ['retryable', 'deferred'],
    ['unavailable', 'permanently-unavailable']
  ] as const)('maps %s to %s', (result, expected) => {
    expect(mapHistoryCheckpointResult(result)).toBe(expected)
  })

  it('maps a missing final snapshot to no-snapshot, never committed', async () => {
    const harness = createHarness()
    harness.seams.historyManager = {
      checkpoint: async () => 'committed',
      suspendSession: () => {},
      appendIncrements: async () => 'ok'
    }
    harness.seams.takeSnapshotAndCheckpoint = async () => ({
      checkpoint: 'no-snapshot',
      snapshot: null
    })

    await expect(
      harness.seams.writeSessionCheckpoint(SESSION_ID, { final: true, teardown: true })
    ).resolves.toBe('no-snapshot')
  })

  it('maps an unavailable non-incremental checkpoint to permanently-unavailable', async () => {
    const harness = createHarness()
    harness.seams.supportsIncrementalCheckpoints = false
    harness.seams.client = {
      request: async (method) =>
        method === 'getSnapshot' ? { snapshot: { marker: 'live' } } : undefined
    }
    harness.seams.historyManager = {
      checkpoint: async () => 'unavailable',
      suspendSession: () => {},
      appendIncrements: async () => 'ok'
    }

    await expect(
      harness.seams.writeSessionCheckpoint(SESSION_ID, { final: false, teardown: false })
    ).resolves.toBe('permanently-unavailable')
  })
})

describe('full checkpoint backoff (#46691 rev2 issue ①)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function makeBackoffHarness(): {
    harness: Harness
    checkpointCalls: ReturnType<typeof vi.fn>
    setResult: (result: 'retryable' | 'committed') => void
  } {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'))
    const harness = createHarness()
    harness.seams.activeSessionIds.add(SESSION_ID)
    harness.seams.sessionsNeedingFullCheckpoint.add(SESSION_ID)
    harness.seams.supportsIncrementalCheckpoints = true
    harness.seams.historyReader = null
    let result: 'retryable' | 'committed' = 'retryable'
    const checkpointCalls = vi.fn(async () =>
      result === 'committed' ? ('committed' as const) : ('retryable' as const)
    )
    harness.seams.historyManager = {
      checkpoint: checkpointCalls,
      suspendSession: () => {},
      appendIncrements: async () => 'ok'
    }
    harness.seams.client = {
      request: async (method, params) => {
        if (method !== 'takePendingOutput') {
          return undefined
        }
        const includeSnapshot = params?.includeSnapshot === true
        return includeSnapshot
          ? { snapshot: { marker: 'live' }, seq: 1, records: [], overflowed: false }
          : null
      }
    }
    return {
      harness,
      checkpointCalls,
      setResult: (next) => {
        result = next
      }
    }
  }

  async function runPass(harness: Harness): Promise<CheckpointWriteResult> {
    return await harness.seams.writeSessionCheckpoint(SESSION_ID, {
      final: false,
      teardown: false
    })
  }

  it('T4: consecutive retryable failures back off 5s → 10s → 20s → 40s → 60s', async () => {
    const { harness, checkpointCalls } = makeBackoffHarness()
    const t0 = Date.now()

    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(1)

    vi.setSystemTime(t0 + 4_999)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(1)

    vi.setSystemTime(t0 + 5_000)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(2)

    vi.setSystemTime(t0 + 5_000 + 9_999)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(2)

    vi.setSystemTime(t0 + 5_000 + 10_000)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(3)

    vi.setSystemTime(t0 + 15_000 + 19_999)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(3)

    vi.setSystemTime(t0 + 15_000 + 20_000)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(4)

    vi.setSystemTime(t0 + 35_000 + 39_999)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(4)

    vi.setSystemTime(t0 + 35_000 + 40_000)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(5)

    vi.setSystemTime(t0 + 75_000 + 59_999)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(5)

    vi.setSystemTime(t0 + 75_000 + 60_000)
    expect(await runPass(harness)).toBe('deferred')
    expect(checkpointCalls).toHaveBeenCalledTimes(6)
  })

  it('T5: success resets backoff and only success updates lastFullCheckpointAt', async () => {
    const { harness, checkpointCalls, setResult } = makeBackoffHarness()
    const t0 = Date.now()

    expect(await runPass(harness)).toBe('deferred')
    expect(harness.seams.lastFullCheckpointAt.has(SESSION_ID)).toBe(false)
    expect(harness.seams.fullCheckpointBackoff.get(SESSION_ID)?.streak).toBe(1)

    vi.setSystemTime(t0 + 5_000)
    expect(await runPass(harness)).toBe('deferred')
    expect(harness.seams.lastFullCheckpointAt.has(SESSION_ID)).toBe(false)
    expect(harness.seams.fullCheckpointBackoff.get(SESSION_ID)?.streak).toBe(2)

    setResult('committed')
    vi.setSystemTime(t0 + 5_000 + 10_000)
    expect(await runPass(harness)).toBe('committed')
    expect(harness.seams.lastFullCheckpointAt.has(SESSION_ID)).toBe(true)
    expect(harness.seams.fullCheckpointBackoff.has(SESSION_ID)).toBe(false)
    expect(harness.seams.sessionsNeedingFullCheckpoint.has(SESSION_ID)).toBe(false)

    harness.seams.sessionsNeedingFullCheckpoint.add(SESSION_ID)
    const callsBefore = checkpointCalls.mock.calls.length
    // Success reset backoff; the success cooldown (45s) is a separate, expected gate.
    vi.setSystemTime(t0 + 15_000 + 45_001)
    expect(await runPass(harness)).toBe('committed')
    expect(checkpointCalls.mock.calls.length).toBe(callsBefore + 1)
  })
})

describe('permanently-unavailable sessions stop polling (#46691 rev2 issue ③)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('T6: clears dirty state and stops the timer; no 5s polling', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.seams.historyManager = {
      checkpoint: async () => 'unavailable',
      suspendSession: () => {},
      appendIncrements: async () => 'ok'
    }
    harness.seams.activeSessionIds.add(SESSION_ID)
    harness.seams.dirtySessionVersions.set(SESSION_ID, 1)
    const checkpointSession = vi.fn(async () => 'permanently-unavailable' as const)
    harness.seams.checkpointSession = checkpointSession
    // Restore the real checkpointSessions (createHarness shadows it for Sleep tests).
    Reflect.deleteProperty(harness.seams, 'checkpointSessions')
    harness.seams.checkpointTimer = setTimeout(() => {}, 5_000)

    await harness.seams.checkpointDirtySessions()

    expect(checkpointSession).toHaveBeenCalledTimes(1)
    expect(harness.seams.dirtySessionVersions.has(SESSION_ID)).toBe(false)
    expect(harness.seams.checkpointTimer).toBeNull()

    await harness.seams.checkpointDirtySessions()
    expect(checkpointSession).toHaveBeenCalledTimes(1)
  })
})

describe('legacy (protocol 4-12) full-checkpoint throttling (#46691 rev2 B1)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function makeLegacyHarness(): {
    harness: Harness
    snapshotCalls: ReturnType<typeof vi.fn>
    setResult: (result: 'retryable' | 'committed') => void
  } {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'))
    const harness = createHarness()
    harness.seams.supportsIncrementalCheckpoints = false
    let result: 'retryable' | 'committed' = 'retryable'
    const checkpoint = vi.fn(async () =>
      result === 'committed' ? ('committed' as const) : ('retryable' as const)
    )
    harness.seams.historyManager = {
      checkpoint,
      suspendSession: () => {},
      appendIncrements: async () => 'ok'
    }
    const snapshotCalls = vi.fn(async () => ({ snapshot: { marker: 'live' } }))
    harness.seams.client = {
      request: async (method) => (method === 'getSnapshot' ? await snapshotCalls() : undefined)
    }
    return {
      harness,
      snapshotCalls,
      setResult: (next) => {
        result = next
      }
    }
  }

  async function runPass(harness: Harness, final = false): Promise<CheckpointWriteResult> {
    return await harness.seams.writeSessionCheckpoint(SESSION_ID, {
      final,
      teardown: final
    })
  }

  it('T7: legacy retryable failures back off instead of running every 5s', async () => {
    const { harness, snapshotCalls } = makeLegacyHarness()
    const t0 = Date.now()

    expect(await runPass(harness)).toBe('deferred')
    expect(snapshotCalls).toHaveBeenCalledTimes(1)

    vi.setSystemTime(t0 + 4_999)
    expect(await runPass(harness)).toBe('deferred')
    expect(snapshotCalls).toHaveBeenCalledTimes(1)

    vi.setSystemTime(t0 + 5_000)
    expect(await runPass(harness)).toBe('deferred')
    expect(snapshotCalls).toHaveBeenCalledTimes(2)

    vi.setSystemTime(t0 + 15_000)
    expect(await runPass(harness)).toBe('deferred')
    expect(snapshotCalls).toHaveBeenCalledTimes(3)
  })

  it('T8: legacy success advances lastFullCheckpointAt and enables the 45s cooldown', async () => {
    const { harness, snapshotCalls, setResult } = makeLegacyHarness()
    const t0 = Date.now()

    expect(await runPass(harness)).toBe('deferred')
    setResult('committed')
    vi.setSystemTime(t0 + 5_000)
    expect(await runPass(harness)).toBe('committed')
    expect(harness.seams.lastFullCheckpointAt.has(SESSION_ID)).toBe(true)
    expect(harness.seams.fullCheckpointBackoff.has(SESSION_ID)).toBe(false)

    const calls = snapshotCalls.mock.calls.length
    expect(await runPass(harness)).toBe('deferred')
    expect(snapshotCalls.mock.calls.length).toBe(calls)
  })

  it('T9: legacy final (Sleep) is never throttled', async () => {
    const { harness, snapshotCalls, setResult } = makeLegacyHarness()

    expect(await runPass(harness)).toBe('deferred')
    const calls = snapshotCalls.mock.calls.length

    setResult('committed')
    expect(await runPass(harness, true)).toBe('committed')
    expect(snapshotCalls.mock.calls.length).toBe(calls + 1)
  })
})
