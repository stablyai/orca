import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { createAuditedWorkflowTables, migrateAuditedWorkflowSchema } from './audited-task-schema'
import { createAuditedTaskAtomically } from './audited-task-creation'
import { applyTransitionCas, type ApplyTransitionArgs } from './audited-task-transitions'

describe('applyTransitionCas', () => {
  let db: Database.Database | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function freshDb(): Database.Database {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    migrateAuditedWorkflowSchema(db)
    return db
  }

  function createTask(database: Database.Database) {
    return createAuditedTaskAtomically(
      database,
      {
        repoId: 'repo1',
        sourceRepoPath: '/repos/repo1',
        baseCommit: 'a'.repeat(40),
        hostId: 'local',
        title: 'CAS test',
        spec: { title: 'CAS test', description: '' },
        source: 'custom',
        risk: 'low'
      },
      1000
    )
  }

  it('applies the transition and persisted from_state exactly equals fromState', () => {
    const database = freshDb()
    const task = createTask(database)

    const result = applyTransitionCas(
      database,
      {
        taskId: task.id,
        fromState: 'selected',
        toState: 'triaging',
        actor: 'control',
        eventType: 'x'
      },
      2000
    )

    expect(result.ok).toBe(true)
    const transitions = database
      .prepare('SELECT * FROM audited_transitions WHERE task_id = ? ORDER BY seq')
      .all(task.id) as { from_state: string | null; to_state: string }[]
    expect(transitions[1].from_state).toBe('selected')
    expect(transitions[1].to_state).toBe('triaging')
  })

  it('two callers racing from the same stale snapshot: exactly one succeeds, the other gets lock_contended', () => {
    const database = freshDb()
    const task = createTask(database)

    // Simulate two processes/handlers that both read the task while it was
    // 'selected' and BOTH decide to transition it — one to 'triaging', one to
    // 'cancelled'. Only one may win; the loser must not corrupt history.
    const callerA: ApplyTransitionArgs = {
      taskId: task.id,
      fromState: 'selected',
      toState: 'triaging',
      actor: 'control',
      eventType: 'caller_a'
    }
    const callerB: ApplyTransitionArgs = {
      taskId: task.id,
      fromState: 'selected',
      toState: 'cancelled',
      actor: 'human',
      eventType: 'caller_b'
    }

    const resultA = applyTransitionCas(database, callerA, 3000)
    const resultB = applyTransitionCas(database, callerB, 3001)

    // Exactly one succeeded.
    const outcomes = [resultA.ok, resultB.ok]
    expect(outcomes.filter(Boolean)).toHaveLength(1)

    const loser = resultA.ok ? resultB : resultA
    expect(loser).toEqual({ ok: false, reasonCode: 'lock_contended' })

    // The task ended up in exactly the winner's target state — never a
    // blend, never the loser's state.
    const finalTask = database
      .prepare('SELECT state FROM audited_tasks WHERE id = ?')
      .get(task.id) as {
      state: string
    }
    const winnerToState = resultA.ok ? callerA.toState : callerB.toState
    expect(finalTask.state).toBe(winnerToState)

    // History contains task_created + exactly ONE more transition (the
    // winner's) — the loser never wrote a row, so history is never
    // ambiguous or contradictory.
    const transitions = database
      .prepare('SELECT * FROM audited_transitions WHERE task_id = ? ORDER BY seq')
      .all(task.id) as { event_type: string; from_state: string | null; to_state: string }[]
    expect(transitions).toHaveLength(2)
    expect(transitions[0].event_type).toBe('task_created')
    expect(transitions[1].event_type).toBe(resultA.ok ? 'caller_a' : 'caller_b')
    // The winner's persisted from_state is the true prior state, not stale.
    expect(transitions[1].from_state).toBe('selected')
  })

  it('rejects a transition whose fromState does not match, without mutating state or history', () => {
    const database = freshDb()
    const task = createTask(database)

    const result = applyTransitionCas(
      database,
      {
        taskId: task.id,
        fromState: 'implementing', // never actually true — task is 'selected'
        toState: 'awaiting_code_audit',
        actor: 'control',
        eventType: 'stale'
      },
      4000
    )

    expect(result).toEqual({ ok: false, reasonCode: 'lock_contended' })
    expect(database.prepare('SELECT state FROM audited_tasks WHERE id = ?').get(task.id)).toEqual({
      state: 'selected'
    })
    expect(
      database
        .prepare('SELECT COUNT(*) as c FROM audited_transitions WHERE task_id = ?')
        .get(task.id)
    ).toEqual({ c: 1 })
  })

  it('returns task_not_found for a nonexistent task and writes nothing', () => {
    const database = freshDb()
    const result = applyTransitionCas(
      database,
      {
        taskId: 'nope',
        fromState: 'selected',
        toState: 'triaging',
        actor: 'control',
        eventType: 'x'
      },
      5000
    )
    expect(result).toEqual({ ok: false, reasonCode: 'task_not_found' })
    expect(database.prepare('SELECT COUNT(*) as c FROM audited_transitions').get()).toEqual({
      c: 0
    })
  })

  it('a sequence of correctly-chained transitions (each using the previous result as fromState) always succeeds', () => {
    const database = freshDb()
    const task = createTask(database)

    const r1 = applyTransitionCas(
      database,
      {
        taskId: task.id,
        fromState: 'selected',
        toState: 'triaging',
        actor: 'control',
        eventType: '1'
      },
      6000
    )
    expect(r1.ok).toBe(true)
    if (!r1.ok) {
      throw new Error('unreachable')
    }

    const r2 = applyTransitionCas(
      database,
      {
        taskId: task.id,
        fromState: r1.task.state,
        toState: 'planning',
        actor: 'triage',
        eventType: '2'
      },
      6001
    )
    expect(r2.ok).toBe(true)

    const transitions = database
      .prepare(
        'SELECT event_type, from_state, to_state FROM audited_transitions WHERE task_id = ? ORDER BY seq'
      )
      .all(task.id)
    expect(transitions).toEqual([
      { event_type: 'task_created', from_state: null, to_state: 'selected' },
      { event_type: '1', from_state: 'selected', to_state: 'triaging' },
      { event_type: '2', from_state: 'triaging', to_state: 'planning' }
    ])
  })
})
