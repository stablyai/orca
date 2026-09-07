import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { projectAttemptOutcome } from './attempt-outcome-projection'
import { createRootDispatch } from './root-dispatch-test-fixture'
import type {
  AttemptObservationFactInput,
  AttemptObservationFacet,
  AttemptObservationPayloadByFacet
} from './attempt-observation-types'

// Mirrors the inputs worker-terminal-attention-query assembles for the production projection.
function projectOutcome(
  db: OrchestrationDb,
  dispatchId: string,
  authorityNow: { execution?: number; home: number },
  freshAfterMs?: number
): ReturnType<typeof projectAttemptOutcome> {
  const dispatch = db.getDispatchContextById(dispatchId)!
  const activeSibling = Boolean(
    db.db
      .prepare(
        `SELECT active.id FROM dispatch_contexts active
         JOIN worker_dispatches worker ON worker.dispatch_id = active.id
         WHERE active.task_id = ? AND active.id != ?
           AND active.status IN ('pending', 'dispatched')
           AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
         LIMIT 1`
      )
      .get(dispatch.task_id, dispatchId)
  )
  return projectAttemptOutcome({
    dispatchId,
    taskId: dispatch.task_id,
    facts: db.getAttemptObservationFacts(dispatchId),
    activeSibling,
    authorityNow,
    freshAfterMs
  })
}

describe('durable Attempt observation and outcome projection', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createAttempt(): { taskId: string; dispatchId: string } {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'observe outcome' })
    const dispatch = createRootDispatch(db, task.id, 'term_observed')
    return { taskId: task.id, dispatchId: dispatch.id }
  }

  function fact<F extends AttemptObservationFacet>(
    dispatchId: string,
    overrides: {
      facet: F
      payload: AttemptObservationPayloadByFacet[F]
      id?: string
      sequence?: number
      authorityId?: string
      authorityClock?: 'execution' | 'home'
      sourceObservedAt?: number | null
      executionReceivedAt?: number | null
      homeReceivedAt?: number
    }
  ): Extract<AttemptObservationFactInput, { facet: F }> {
    const { facet, payload, ...rest } = overrides
    return {
      id: `fact_${overrides.sequence ?? 1}`,
      dispatchId,
      sequence: 1,
      authorityId: 'execution-host-1',
      authorityClock: 'execution',
      facet,
      payload,
      sourceObservedAt: 900,
      executionReceivedAt: 1_000,
      homeReceivedAt: 50_000,
      ...rest
    } as Extract<AttemptObservationFactInput, { facet: F }>
  }

  it('persists separated evidence facets and additive uncertain outcomes', () => {
    const { dispatchId } = createAttempt()
    const facts: AttemptObservationFactInput[] = [
      fact(dispatchId, {
        id: 'process',
        sequence: 1,
        facet: 'process_turn',
        payload: { process: 'stopped', turn: 'finished' }
      }),
      fact(dispatchId, {
        id: 'git',
        sequence: 2,
        facet: 'artifact_git',
        payload: { artifacts: 'present', git: 'changed' }
      }),
      fact(dispatchId, {
        id: 'report',
        sequence: 3,
        facet: 'worker_report',
        payload: { status: 'missing', reason: 'worker exited before reporting' }
      }),
      fact(dispatchId, {
        id: 'ack',
        sequence: 4,
        facet: 'coordinator_ack',
        payload: { status: 'acknowledged' }
      }),
      fact(dispatchId, {
        id: 'liveness',
        sequence: 5,
        facet: 'liveness',
        payload: { status: 'exited' }
      }),
      fact(dispatchId, {
        id: 'outcome',
        sequence: 6,
        facet: 'outcome',
        payload: { outcome: 'finished_unverified', reason: 'missing worker report' }
      })
    ]
    for (const observation of facts) {
      db!.recordAttemptObservation(observation)
    }

    expect(db!.getAttemptObservationFacts(dispatchId)).toHaveLength(6)
    expect(projectOutcome(db!, dispatchId, { execution: 1_010, home: 50_010 })).toMatchObject({
      outcome: 'finished_unverified',
      taskOutcome: 'finished_unverified',
      outcomeSource: 'additive_fact',
      artifactGit: { artifacts: 'present', git: 'changed' },
      workerReport: { status: 'missing' },
      coordinatorAcknowledgment: { status: 'acknowledged' },
      liveness: { status: 'exited' }
    })
    expect(db!.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('stores valid JSON when an optional payload field is explicitly undefined', () => {
    const { dispatchId } = createAttempt()
    const observation = fact(dispatchId, {
      id: 'undefined-quiet',
      sequence: 1,
      facet: 'process_turn',
      payload: { process: 'running', turn: 'waiting', quiet: undefined }
    })

    expect(db!.recordAttemptObservation(observation).fact.payload).toEqual({
      process: 'running',
      turn: 'waiting',
      quiet: null
    })
    expect(() => db!.getAttemptObservationFacts(dispatchId)).not.toThrow()
  })

  it('retains facts and the same projection after a database reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-attempt-observation-'))
    const path = join(dir, 'orchestration.sqlite')
    try {
      db = new OrchestrationDb(path)
      const task = db.createTask({ spec: 'durable observation' })
      const dispatch = createRootDispatch(db, task.id, 'term_durable')
      db.recordAttemptObservation(
        fact(dispatch.id, {
          id: 'durable_unknown',
          sequence: 1,
          facet: 'outcome',
          payload: { outcome: 'outcome_unknown', reason: 'host disconnected' }
        })
      )
      db.close()
      db = new OrchestrationDb(path)

      expect(projectOutcome(db, dispatch.id, { execution: 1_001, home: 50_001 })).toMatchObject({
        outcome: 'outcome_unknown',
        outcomeSource: 'additive_fact',
        outcomeReason: 'host disconnected'
      })
    } finally {
      db?.close()
      db = undefined
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps worker_done settlement as the atomic success fast path', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'worker_done fast path' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_fast_path',
      paneKey: 'tab_fast:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processIncarnation: 'worker:1',
      worktreeId: 'repo::worker',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    const report = {
      taskId: task.id,
      dispatchId: started.dispatch.id,
      outcome: 'succeeded' as const,
      result: 'reported success',
      observation: {
        id: 'worker_report:message-1',
        authorityId: 'run_home:run-1',
        homeReceivedAt: 1_000
      }
    }

    expect(db.settleWorkerReport(report)).toMatchObject({ action: 'settled', duplicate: false })
    expect(db.settleWorkerReport(report)).toMatchObject({ action: 'settled', duplicate: true })
    expect(db.getAttemptObservationFacts(started.dispatch.id)).toHaveLength(1)
    expect(projectOutcome(db, started.dispatch.id, { home: 1_001 })).toMatchObject({
      outcome: 'succeeded',
      taskOutcome: 'succeeded',
      outcomeSource: 'worker_report'
    })
    expect(db.getTask(task.id)?.status).toBe('completed')
  })

  it('is replay-idempotent, rejects changed replays, and reduces reordered facts by sequence', () => {
    const { dispatchId } = createAttempt()
    const later = fact(dispatchId, {
      id: 'later',
      sequence: 3,
      facet: 'process_turn',
      payload: { process: 'running', turn: 'working' }
    })
    const earlier = fact(dispatchId, {
      id: 'earlier',
      sequence: 1,
      facet: 'process_turn',
      payload: { process: 'running', turn: 'waiting' }
    })

    expect(db!.recordAttemptObservation(later).duplicate).toBe(false)
    expect(db!.recordAttemptObservation(earlier).duplicate).toBe(false)
    expect(
      db!.recordAttemptObservation({ ...later, payload: { turn: 'working', process: 'running' } })
        .duplicate
    ).toBe(true)
    expect(() =>
      db!.recordAttemptObservation({ ...later, payload: { process: 'stopped', turn: 'finished' } })
    ).toThrow(/different content/)
    expect(() => db!.recordAttemptObservation({ ...earlier, id: 'sequence_collision' })).toThrow(
      /sequence 1 is already/
    )
    expect(projectOutcome(db!, dispatchId, { execution: 1_001, home: 50_001 }).processTurn).toEqual(
      { process: 'running', turn: 'working' }
    )
  })

  it('keeps a late accepted report on its Attempt without settling an active sibling Task', () => {
    const { taskId, dispatchId } = createAttempt()
    db!.failDispatch(dispatchId, 'first attempt ended')
    const sibling = db!.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId,
      startOptions: {}
    })
    db!.recordAttemptObservation(
      fact(dispatchId, {
        id: 'late_report',
        sequence: 1,
        facet: 'worker_report',
        payload: { status: 'accepted', outcome: 'succeeded', reportId: 'message-1', late: true }
      })
    )

    expect(projectOutcome(db!, dispatchId, { execution: 1_001, home: 50_001 })).toMatchObject({
      outcome: 'succeeded',
      taskOutcome: 'outcome_unknown',
      outcomeSource: 'worker_report',
      activeSibling: true
    })
    expect(db!.getTask(taskId)?.status).toBe('dispatched')
    expect(db!.getDispatchContextById(sibling.dispatch.id)?.status).toBe('pending')
  })

  it('projects a missing report plus observed finish as finished_unverified', () => {
    const { dispatchId } = createAttempt()
    db!.recordAttemptObservation(
      fact(dispatchId, {
        id: 'finished',
        sequence: 1,
        facet: 'process_turn',
        payload: { process: 'stopped', turn: 'finished' }
      })
    )
    db!.recordAttemptObservation(
      fact(dispatchId, {
        id: 'missing',
        sequence: 2,
        facet: 'worker_report',
        payload: { status: 'missing' }
      })
    )

    expect(projectOutcome(db!, dispatchId, { execution: 1_001, home: 50_001 })).toMatchObject({
      outcome: 'finished_unverified',
      outcomeSource: 'observation'
    })
  })

  it('never infers success from a quiet PTY, clean Git, or coordinator acknowledgment', () => {
    const { dispatchId } = createAttempt()
    for (const observation of [
      fact(dispatchId, {
        id: 'quiet',
        sequence: 1,
        facet: 'process_turn',
        payload: { process: 'running', turn: 'waiting', quiet: true }
      }),
      fact(dispatchId, {
        id: 'clean',
        sequence: 2,
        facet: 'artifact_git',
        payload: { artifacts: 'absent', git: 'clean' }
      }),
      fact(dispatchId, {
        id: 'coordinator_ack',
        sequence: 3,
        facet: 'coordinator_ack',
        payload: { status: 'acknowledged' }
      }),
      fact(dispatchId, {
        id: 'live',
        sequence: 4,
        facet: 'liveness',
        payload: { status: 'live', ptyIds: ['pty-1'] }
      })
    ]) {
      db!.recordAttemptObservation(observation)
    }

    expect(projectOutcome(db!, dispatchId, { execution: 1_001, home: 50_001 }).outcome).toBe(
      'in_progress'
    )
  })

  it('computes freshness only in the selected authority host clock domain', () => {
    const { dispatchId } = createAttempt()
    db!.recordAttemptObservation(
      fact(dispatchId, {
        id: 'skewed_source',
        sequence: 1,
        facet: 'liveness',
        payload: { status: 'live', ptyIds: ['pty-1'] },
        sourceObservedAt: 9_000_000,
        executionReceivedAt: 1_000,
        homeReceivedAt: 90_000
      })
    )

    expect(
      projectOutcome(db!, dispatchId, { execution: 1_025, home: 900_000 }, 100).liveness
    ).toEqual({
      status: 'live',
      ptyIds: ['pty-1'],
      freshness: { status: 'fresh', clock: 'execution', observedAt: 1_000, ageMs: 25 }
    })
  })

  it('uses the home receipt clock when the home host owns freshness', () => {
    const { dispatchId } = createAttempt()
    db!.recordAttemptObservation(
      fact(dispatchId, {
        id: 'home_clock',
        sequence: 1,
        authorityId: 'home-host-1',
        authorityClock: 'home',
        facet: 'liveness',
        payload: { status: 'live', ptyIds: ['pty-1'] },
        sourceObservedAt: 9_000_000,
        executionReceivedAt: 1,
        homeReceivedAt: 50_000
      })
    )

    expect(
      projectOutcome(db!, dispatchId, { execution: 1_000_000, home: 50_025 }, 100).liveness
    ).toEqual({
      status: 'live',
      ptyIds: ['pty-1'],
      freshness: { status: 'fresh', clock: 'home', observedAt: 50_000, ageMs: 25 }
    })
  })

  it.each([
    ['live', { status: 'live', ptyIds: ['ssh-pty'] as string[] }, { status: 'live' }],
    [
      'unverifiable',
      { status: 'unverifiable', reason: 'SSH connection lost' },
      { status: 'unverifiable', reason: 'SSH connection lost' }
    ],
    ['exited', { status: 'exited' }, { status: 'exited' }]
  ] as const)('preserves the canonical SSH %s verdict', (_name, payload, expected) => {
    const { dispatchId } = createAttempt()
    db!.recordAttemptObservation(
      fact(dispatchId, {
        id: 'ssh_liveness',
        sequence: 1,
        facet: 'liveness',
        payload
      })
    )

    expect(
      projectOutcome(db!, dispatchId, { execution: 1_010, home: 50_010 }).liveness
    ).toMatchObject(expected)
  })

  it('degrades a stale or future live observation to unverifiable without claiming exit', () => {
    const { dispatchId } = createAttempt()
    db!.recordAttemptObservation(
      fact(dispatchId, {
        id: 'future_live',
        sequence: 1,
        facet: 'liveness',
        payload: { status: 'live', ptyIds: ['pty-1'] },
        executionReceivedAt: 10_000
      })
    )

    expect(
      projectOutcome(db!, dispatchId, { execution: 1_000, home: 50_010 }).liveness
    ).toMatchObject({ status: 'unverifiable', freshness: { status: 'future' } })
  })
})
