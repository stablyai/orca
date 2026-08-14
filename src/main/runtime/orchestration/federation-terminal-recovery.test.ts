import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { classifyFederationTerminalRecoveryFailure } from './federation-terminal-recovery-policy'

type HistoricalDispatch = { dispatchId: string; rowId: number }

describe('terminal federation acknowledgment recovery', () => {
  const databases: OrchestrationDb[] = []
  const runtimes: OrcaRuntimeService[] = []
  const tempDirs: string[] = []

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
      runtime.stopOrchestrationFederationRelay()
    }
    for (const db of databases.splice(0)) {
      db.close()
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    vi.useRealTimers()
  })

  function createRuntime(
    db: OrchestrationDb,
    sync?: (dispatchId: string) => Promise<void>
  ): { runtime: OrcaRuntimeService; sync: ReturnType<typeof vi.spyOn> } {
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: { resolve: vi.fn(), call: vi.fn() }
    })
    runtimes.push(runtime)
    const syncSpy = vi
      .spyOn(runtime, 'syncOrchestrationFederatedDispatch')
      .mockImplementation(sync ?? (async () => {}))
    runtime.setOrchestrationDb(db)
    return { runtime, sync: syncSpy }
  }

  function createDb(onDisk = false): { db: OrchestrationDb; dbPath?: string } {
    if (!onDisk) {
      const db = new OrchestrationDb(':memory:')
      databases.push(db)
      return { db }
    }
    const dir = mkdtempSync(join(tmpdir(), 'orca-federation-recovery-'))
    const dbPath = join(dir, 'orchestration.db')
    tempDirs.push(dir)
    const db = new OrchestrationDb(dbPath)
    databases.push(db)
    return { db, dbPath }
  }

  function createHistoricalDispatch(db: OrchestrationDb, suffix: string): string {
    const run = db.createRun({
      objective: `recover ${suffix}`,
      coordinatorHandle: `term_coord_${suffix}`,
      coordinatorPaneKey: `tab_coord_${suffix}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    })
    const task = db.createTask({ spec: `settle ${suffix}`, runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: 'home_epoch',
      federation: {
        environmentId: `environment_${suffix}`,
        environmentName: suffix,
        peerFingerprint: `peer_${suffix}`,
        protocolVersion: 3
      }
    })
    db.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'completed',
      state: 'succeeded'
    })
    db.setFederatedHomeImportSequence(started.dispatch.id, 1)
    return started.dispatch.id
  }

  function terminalRecoveryState(db: OrchestrationDb, dispatchId: string) {
    return db.getFederatedDispatch(dispatchId) as unknown as {
      to_home_imported_sequence: number
      to_home_acknowledged_sequence: number
      terminal_ack_recovery_state?: string
      terminal_ack_recovery_attempts?: number
      terminal_ack_recovery_next_at_ms?: number
      terminal_ack_recovery_error_code?: string | null
    }
  }

  it.each(['dispatch_not_found', 'environment_not_found', 'peer_changed'])(
    'classifies proven permanent error %s as terminal',
    (code) => {
      expect(classifyFederationTerminalRecoveryFailure(new OrchestrationError(code, code))).toEqual(
        { errorCode: code, terminal: true }
      )
    }
  )

  it.each(['capability_unsupported', 'operation_unknown', 'runtime_timeout'])(
    'keeps non-terminal error %s retryable',
    (code) => {
      expect(classifyFederationTerminalRecoveryFailure(new OrchestrationError(code, code))).toEqual(
        { errorCode: code, terminal: false }
      )
    }
  )

  it('durably terminalizes a permanent failure and does not retry it after restart', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db, dbPath } = createDb(true)
    const dispatchId = createHistoricalDispatch(db, 'retired')
    const attempts: number[] = []
    const { runtime } = createRuntime(db, async () => {
      attempts.push(Date.now())
      throw new OrchestrationError('environment_not_found', 'The saved worker was decommissioned.')
    })

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(attempts).toEqual([0])
    expect(db.findNextTerminalFederatedDispatchPendingAcknowledgment(0)).toBeUndefined()
    expect(terminalRecoveryState(db, dispatchId)).toMatchObject({
      to_home_imported_sequence: 1,
      to_home_acknowledged_sequence: 0,
      terminal_ack_recovery_state: 'terminal',
      terminal_ack_recovery_attempts: 1,
      terminal_ack_recovery_error_code: 'environment_not_found'
    })

    runtime.stopOrchestrationFederationRelay()
    db.close()
    databases.splice(databases.indexOf(db), 1)
    const restartedDb = new OrchestrationDb(dbPath!)
    databases.push(restartedDb)
    const { sync: restartedSync } = createRuntime(restartedDb)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(restartedSync).not.toHaveBeenCalled()
    expect(terminalRecoveryState(restartedDb, dispatchId).terminal_ack_recovery_state).toBe(
      'terminal'
    )
  })

  it('backs off transient failures durably and converges when the worker returns', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db } = createDb()
    const dispatchId = createHistoricalDispatch(db, 'healing')
    const attempts: number[] = []
    const { runtime } = createRuntime(db, async () => {
      attempts.push(Date.now())
      if (attempts.length < 3) {
        throw new Error('worker unavailable')
      }
      db.recordFederatedHomeAcknowledgment({
        dispatchId,
        remoteRuntimeEpoch: 'worker_epoch',
        sequence: 1
      })
    })

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(attempts).toEqual([0, 1_000, 3_000])
    expect(db.getFederatedDispatch(dispatchId)).toMatchObject({
      to_home_acknowledged_sequence: 1
    })
    expect(db.findNextTerminalFederatedDispatchPendingAcknowledgment(0)).toBeUndefined()
  })

  it('persists a transient retry deadline across app restart', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db, dbPath } = createDb(true)
    createHistoricalDispatch(db, 'restart')
    const { runtime, sync: firstSync } = createRuntime(db, async () => {
      throw new Error('transport unavailable')
    })

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(500)
    expect(firstSync).toHaveBeenCalledTimes(1)
    runtime.stopOrchestrationFederationRelay()
    db.close()
    databases.splice(databases.indexOf(db), 1)

    const restartedDb = new OrchestrationDb(dbPath!)
    databases.push(restartedDb)
    const attempts: number[] = []
    createRuntime(restartedDb, async () => {
      attempts.push(Date.now())
      throw new Error('transport unavailable')
    })

    await vi.advanceTimersByTimeAsync(499)
    expect(attempts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toEqual([1_000])
  })

  it('bounds a persisted retry deadline after the wall clock moves backward', async () => {
    vi.useFakeTimers({ now: 100_000 })
    const { db, dbPath } = createDb(true)
    const dispatchId = createHistoricalDispatch(db, 'clock-rollback')
    db.recordFederatedTerminalRecoveryFailure({
      dispatchId,
      errorCode: null,
      terminal: false,
      nowMs: Date.now()
    })
    db.close()
    databases.splice(databases.indexOf(db), 1)
    vi.setSystemTime(0)

    const restartedDb = new OrchestrationDb(dbPath!)
    databases.push(restartedDb)
    const attempts: number[] = []
    createRuntime(restartedDb, async () => {
      attempts.push(Date.now())
      throw new Error('transport unavailable')
    })

    await vi.advanceTimersByTimeAsync(29_999)
    expect(attempts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toEqual([30_000])
  })

  it('keeps unknown failures retryable with capped backoff', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db } = createDb()
    const dispatchId = createHistoricalDispatch(db, 'ambiguous')
    const attempts: number[] = []
    const { runtime } = createRuntime(db, async () => {
      attempts.push(Date.now())
      throw new OrchestrationError('operation_unknown', 'The ACK outcome is unknown.')
    })

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(61_000)

    expect(attempts).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000])
    expect(db.getNextTerminalFederatedDispatchRecoveryAt()).toBe(91_000)
    expect(db.findNextTerminalFederatedDispatchPendingAcknowledgment(0, 91_000)).toMatchObject({
      dispatchId
    })
    expect(terminalRecoveryState(db, dispatchId)).toMatchObject({
      terminal_ack_recovery_state: 'retryable',
      terminal_ack_recovery_attempts: 7,
      terminal_ack_recovery_next_at_ms: 91_000
    })
  })

  it('backs off a fulfilled sync that makes no durable acknowledgment progress', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db } = createDb()
    const dispatchId = createHistoricalDispatch(db, 'no-progress')
    const attempts: number[] = []
    const { runtime } = createRuntime(db, async () => {
      attempts.push(Date.now())
    })

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(7_000)

    expect(attempts).toEqual([0, 1_000, 3_000, 7_000])
    expect(terminalRecoveryState(db, dispatchId)).toMatchObject({
      terminal_ack_recovery_state: 'retryable',
      terminal_ack_recovery_attempts: 4,
      terminal_ack_recovery_next_at_ms: 15_000,
      terminal_ack_recovery_error_code: 'operation_unknown'
    })
  })

  it('continues at base cadence while a fulfilled sync makes durable progress', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db } = createDb()
    const dispatchId = createHistoricalDispatch(db, 'progress')
    db.setFederatedHomeImportSequence(dispatchId, 4)
    const attempts: number[] = []
    const { runtime } = createRuntime(db, async () => {
      attempts.push(Date.now())
      db.recordFederatedHomeAcknowledgment({
        dispatchId,
        remoteRuntimeEpoch: 'worker_epoch',
        sequence: attempts.length
      })
    })

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(attempts).toEqual([0, 1_000, 2_000, 3_000])
    expect(terminalRecoveryState(db, dispatchId)).toMatchObject({
      to_home_acknowledged_sequence: 4,
      terminal_ack_recovery_state: 'pending',
      terminal_ack_recovery_attempts: 0
    })
  })

  it('hands an active dispatch to durable recovery after it becomes terminal', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db } = createDb()
    const dispatchId = createHistoricalDispatch(db, 'active-handoff')
    db.recordWorkerStage({ dispatchId, stage: 'running', state: 'ready' })
    const attempts: number[] = []
    let rejectActive!: () => void
    let active = true
    createRuntime(db, async () => {
      attempts.push(Date.now())
      if (active) {
        active = false
        return new Promise<void>((_resolve, reject) => {
          rejectActive = () => {
            db.recordWorkerStage({ dispatchId, stage: 'completed', state: 'succeeded' })
            reject(new Error('transport unavailable'))
          }
        })
      }
      throw new Error('transport unavailable')
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toEqual([0])
    rejectActive()
    await vi.advanceTimersByTimeAsync(4_000)

    expect(attempts).toEqual([0, 1_000, 2_000, 4_000])
    expect(terminalRecoveryState(db, dispatchId)).toMatchObject({
      terminal_ack_recovery_state: 'retryable',
      terminal_ack_recovery_attempts: 3,
      terminal_ack_recovery_next_at_ms: 8_000
    })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('terminalizes a permanent oldest row without blocking a later recoverable row', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db } = createDb()
    const permanentId = createHistoricalDispatch(db, 'oldest')
    const recoverableId = createHistoricalDispatch(db, 'later')
    const calls: { dispatchId: string; at: number }[] = []
    const { runtime } = createRuntime(db, async (dispatchId) => {
      calls.push({ dispatchId, at: Date.now() })
      if (dispatchId === permanentId) {
        throw new OrchestrationError('dispatch_not_found', 'The old worker discarded the dispatch.')
      }
      db.recordFederatedHomeAcknowledgment({
        dispatchId,
        remoteRuntimeEpoch: 'worker_epoch',
        sequence: 1
      })
    })

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(calls).toEqual([
      { dispatchId: permanentId, at: 0 },
      { dispatchId: recoverableId, at: 1_000 }
    ])
    expect(db.findNextTerminalFederatedDispatchPendingAcknowledgment(0)).toBeUndefined()
  })

  it('skips an already acknowledged duplicate without scheduling work', async () => {
    vi.useFakeTimers({ now: 0 })
    const { db } = createDb()
    const dispatchId = createHistoricalDispatch(db, 'duplicate')
    db.recordFederatedHomeAcknowledgment({
      dispatchId,
      remoteRuntimeEpoch: 'worker_epoch',
      sequence: 1
    })
    const { runtime, sync } = createRuntime(db)

    runtime.ensureOrchestrationFederationRelay()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sync).not.toHaveBeenCalled()
  })

  it('keeps a thousand-row backlog to one timer and one in-flight sync', async () => {
    vi.useFakeTimers({ now: 0 })
    const candidates = Array.from({ length: 1_000 }, (_, index) => ({
      dispatchId: `dispatch_${index + 1}`,
      rowId: index + 1
    }))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: { resolve: vi.fn(), call: vi.fn() }
    })
    runtimes.push(runtime)
    const sync = vi
      .spyOn(runtime, 'syncOrchestrationFederatedDispatch')
      .mockResolvedValue(undefined)
    runtime.setOrchestrationDb({
      listActiveFederatedDispatches: () => [],
      capFederatedTerminalRecoveryDeadlines: () => {},
      findNextTerminalFederatedDispatchPendingAcknowledgment: (afterRowId: number) =>
        candidates.find((candidate) => candidate.rowId > afterRowId),
      getFederatedDispatch: () => ({
        to_home_acknowledged_sequence: 1,
        to_home_imported_sequence: 1
      }),
      recordFederatedTerminalRecoverySuccess: (dispatchId: string) => {
        candidates.splice(
          candidates.findIndex((candidate) => candidate.dispatchId === dispatchId),
          1
        )
      },
      getNextTerminalFederatedDispatchRecoveryAt: () =>
        candidates.length > 0 ? Date.now() : undefined
    } as never)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(sync.mock.calls).toEqual([
      ['dispatch_1'],
      ['dispatch_2'],
      ['dispatch_3'],
      ['dispatch_4']
    ])
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not restart recovery after relay shutdown', async () => {
    vi.useFakeTimers({ now: 0 })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const candidates: HistoricalDispatch[] = [{ dispatchId: 'dispatch_1', rowId: 1 }]
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: { resolve: vi.fn(), call: vi.fn() }
    })
    runtimes.push(runtime)
    const sync = vi.spyOn(runtime, 'syncOrchestrationFederatedDispatch').mockReturnValue(blocked)
    runtime.setOrchestrationDb({
      listActiveFederatedDispatches: () => [],
      capFederatedTerminalRecoveryDeadlines: () => {},
      findNextTerminalFederatedDispatchPendingAcknowledgment: (afterRowId: number) =>
        candidates.find((candidate) => candidate.rowId > afterRowId),
      getFederatedDispatch: () => ({
        to_home_acknowledged_sequence: 0,
        to_home_imported_sequence: 1
      })
    } as never)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    runtime.stopOrchestrationFederationRelay()
    release()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sync).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
