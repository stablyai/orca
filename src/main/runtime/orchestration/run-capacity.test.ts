import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

describe('orchestration run capacity', () => {
  let db: OrchestrationDb | undefined
  let tempDirectory: string | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    db?.close()
    if (tempDirectory) {
      rmSync(tempDirectory, { recursive: true, force: true })
    }
  })

  function setup(targetConcurrency = 2): { runId: string } {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'keep an explicitly enrolled wave full',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'repo:worktree:tab:leaf'
    })
    db.configureRunCapacity(run.id, targetConcurrency)
    return { runId: run.id }
  }

  function startAndSettle(taskId: string, terminalHandle: string): string {
    const started = db!.createStartingWorkerDispatch({
      taskId,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1,
      capacitySlot: true
    })
    db!.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      paneKey: `repo:worktree:tab:${terminalHandle}`,
      processIncarnation: `pid:${terminalHandle}`,
      worktreeId: 'repo::worktree',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db!.markWorkerDispatchReady(started.dispatch.id)
    db!.settleWorkerReport({
      taskId,
      dispatchId: started.dispatch.id,
      outcome: 'succeeded',
      result: '{}'
    })
    return started.dispatch.id
  }

  it('exposes only enrolled ready tasks as launchable capacity', () => {
    const { runId } = setup(3)
    const active = db!.createTask({ spec: 'active', runId, capacityEligible: true })
    createRootDispatch(db!, active.id, 'term_active')
    const ready = db!.createTask({ spec: 'ready', runId, capacityEligible: true })
    const unproven = db!.createTask({ spec: 'not enrolled', runId })
    const dependency = db!.createTask({ spec: 'dependency', runId })
    const pending = db!.createTask({
      spec: 'blocked on dependency',
      runId,
      deps: [dependency.id],
      capacityEligible: true
    })

    const snapshot = db!.getRunCapacity(runId)

    expect(snapshot).toMatchObject({
      runId,
      targetConcurrency: 3,
      activeCount: 1,
      availableSlots: 2,
      launchableCount: 1
    })
    expect(snapshot.launchableTasks.map((task) => task.id)).toEqual([ready.id])
    expect(snapshot.eligiblePendingTaskIds).toEqual([pending.id])
    expect(snapshot.launchableTasks.map((task) => task.id)).not.toContain(unproven.id)
  })

  it('does not offer a pre-fix split Task that still has an active Dispatch', () => {
    const { runId } = setup(2)
    const split = db!.createTask({ spec: 'legacy split', runId, capacityEligible: true })
    createRootDispatch(db!, split.id, 'term_active')
    db!.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(split.id)

    expect(db!.getRunCapacity(runId).launchableTasks).toEqual([])
  })

  it('does not offer a Task while a decision gate remains pending', () => {
    const { runId } = setup(1)
    const task = db!.createTask({ spec: 'gated work', runId, capacityEligible: true })
    const gate = db!.createGate({ taskId: task.id, question: 'Proceed?' })
    db!.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)

    expect(db!.getRunCapacity(runId).launchableTasks).toEqual([])
    db!.resolveGate(gate.id, 'yes')
    expect(db!.getRunCapacity(runId).launchableTasks.map((candidate) => candidate.id)).toEqual([
      task.id
    ])
  })

  it('bounds the indexed launchable query by the available slots', () => {
    const { runId } = setup(3)
    for (let index = 0; index < 200; index += 1) {
      db!.createTask({ spec: `ready ${index}`, runId, capacityEligible: true })
    }
    const prepare = db!.db.prepare.bind(db!.db)
    let launchableSql = ''
    vi.spyOn(db!.db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('SELECT tasks.* FROM tasks')) {
        launchableSql = sql
      }
      return prepare(sql)
    })

    expect(db!.getRunCapacity(runId).launchableTasks).toHaveLength(3)
    expect(launchableSql).toContain('LIMIT ?')
    const plan = prepare(`EXPLAIN QUERY PLAN ${launchableSql}`).all(runId, 3) as {
      detail: string
    }[]
    expect(plan.some((row) => row.detail.includes('idx_tasks_capacity_ready'))).toBe(true)
  })

  it('atomically refuses a capacity start above the exact target', () => {
    const { runId } = setup(1)
    const first = db!.createTask({ spec: 'first', runId, capacityEligible: true })
    const second = db!.createTask({ spec: 'second', runId, capacityEligible: true })

    db!.createStartingWorkerDispatch({
      taskId: first.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1,
      capacitySlot: true
    })

    expect(() =>
      db!.createStartingWorkerDispatch({
        taskId: second.id,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: 1,
        capacitySlot: true
      })
    ).toThrowError(/target concurrency 1/)
    expect(db!.getTask(second.id)?.status).toBe('ready')
    expect(() => createRootDispatch(db!, second.id, 'term_bypass')).toThrowError(
      /target concurrency 1/
    )
  })

  it('claims federated capacity at the authoritative Run home', () => {
    const { runId } = setup(1)
    const first = db!.createTask({ spec: 'first remote', runId, capacityEligible: true })
    const second = db!.createTask({ spec: 'second remote', runId, capacityEligible: true })
    const federation = {
      environmentId: 'environment_windows',
      environmentName: 'windows',
      peerFingerprint: 'windows_peer',
      protocolVersion: 3
    }

    db!.createStartingWorkerDispatch({
      taskId: first.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1,
      capacitySlot: true,
      federation
    })

    expect(() =>
      db!.createStartingWorkerDispatch({
        taskId: second.id,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: 1,
        capacitySlot: true,
        federation
      })
    ).toThrowError(/target concurrency 1/)
  })

  it('serializes simultaneous low-level Dispatch claims across database connections', () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'orca-run-capacity-race-'))
    const databasePath = join(tempDirectory, 'orchestration.db')
    db = new OrchestrationDb(databasePath)
    const concurrent = new OrchestrationDb(databasePath)
    try {
      const run = db.createRun({
        objective: 'serialize low-level claims',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'repo:worktree:tab:leaf'
      })
      db.configureRunCapacity(run.id, 1)
      const loser = db.createTask({ spec: 'losing claim', runId: run.id, capacityEligible: true })
      const winner = db.createTask({ spec: 'winning claim', runId: run.id, capacityEligible: true })
      const prepare = db.db.prepare.bind(db.db)
      let winnerDispatchId: string | undefined
      vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
        if (!winnerDispatchId && sql.includes('INSERT INTO dispatch_contexts')) {
          winnerDispatchId = createRootDispatch(concurrent, winner.id, 'term_winner').id
        }
        return prepare(sql)
      })

      expect(() => createRootDispatch(db!, loser.id, 'term_loser')).toThrowError(
        /target concurrency 1/
      )
      expect(winnerDispatchId).toBeDefined()
      expect(db.getTask(loser.id)?.status).toBe('ready')
      expect(db.getRunCapacity(run.id)).toMatchObject({ activeCount: 1, availableSlots: 0 })
    } finally {
      concurrent.close()
    }
  })

  it('requires explicit enrollment for capacity starts', () => {
    const { runId } = setup(1)
    const task = db!.createTask({ spec: 'ordinary ready task', runId })

    expect(() =>
      db!.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: 1,
        capacitySlot: true
      })
    ).toThrowError(/not enrolled/)
  })

  it('reports settled terminal debt separately from live lane capacity', () => {
    const { runId } = setup(2)
    const task = db!.createTask({ spec: 'settled worker', runId, capacityEligible: true })
    const dispatchId = startAndSettle(task.id, 'term_worker')

    const snapshot = db!.getRunCapacity(runId)

    expect(snapshot.activeCount).toBe(0)
    expect(snapshot.availableSlots).toBe(2)
    expect(snapshot.settledTerminalDebt).toEqual([
      expect.objectContaining({ dispatchId, terminalState: 'reclaimable' })
    ])
  })

  it('recomputes slots after simultaneous settlements and dependency promotion', () => {
    const { runId } = setup(2)
    const first = db!.createTask({ spec: 'first active', runId, capacityEligible: true })
    const second = db!.createTask({ spec: 'second active', runId, capacityEligible: true })
    const dependent = db!.createTask({
      spec: 'newly ready replacement',
      runId,
      deps: [first.id],
      capacityEligible: true
    })
    const firstStarted = db!.createStartingWorkerDispatch({
      taskId: first.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1,
      capacitySlot: true
    })
    const secondStarted = db!.createStartingWorkerDispatch({
      taskId: second.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1,
      capacitySlot: true
    })
    for (const [task, started, terminal] of [
      [first, firstStarted, 'term_first'],
      [second, secondStarted, 'term_second']
    ] as const) {
      db!.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: terminal,
        paneKey: `repo:worktree:tab:${terminal}`,
        processIncarnation: `pid:${terminal}`,
        worktreeId: 'repo::worktree',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: 'created'
      })
      db!.markWorkerDispatchReady(started.dispatch.id)
      db!.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    }

    const snapshot = db!.getRunCapacity(runId)
    expect(snapshot.activeCount).toBe(0)
    expect(snapshot.availableSlots).toBe(2)
    expect(snapshot.launchableTasks.map((task) => task.id)).toEqual([dependent.id])
  })

  it('excludes failed and blocked enrolled tasks when no eligible work remains', () => {
    const { runId } = setup(2)
    const failed = db!.createTask({ spec: 'failed', runId, capacityEligible: true })
    const blocked = db!.createTask({ spec: 'blocked', runId, capacityEligible: true })
    db!.updateTaskStatus(failed.id, 'failed')
    db!.updateTaskStatus(blocked.id, 'blocked')

    const snapshot = db!.getRunCapacity(runId)
    expect(snapshot.launchableCount).toBe(0)
    expect(snapshot.eligiblePendingTaskIds).toEqual([blocked.id])
  })

  it('stops offering an enrolled Task after its retry circuit breaks', () => {
    const { runId } = setup(1)
    const task = db!.createTask({
      spec: 'repeatedly failing capacity work',
      runId,
      capacityEligible: true
    })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dispatch = createRootDispatch(db!, task.id, `term_retry_${attempt}`)
      db!.failDispatch(dispatch.id, `attempt ${attempt + 1}`)
    }

    expect(db!.getTask(task.id)?.status).toBe('failed')
    expect(db!.getRunCapacity(runId)).toMatchObject({
      activeCount: 0,
      availableSlots: 1,
      launchableCount: 0,
      launchableTasks: []
    })
  })

  it('persists target and enrollment across a database restart', () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'orca-run-capacity-'))
    const databasePath = join(tempDirectory, 'orchestration.db')
    db = new OrchestrationDb(databasePath)
    const run = db.createRun({
      objective: 'restart durable capacity',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'repo:worktree:tab:leaf'
    })
    const task = db.createTask({
      spec: 'durable enrollment',
      runId: run.id,
      capacityEligible: true
    })
    db.configureRunCapacity(run.id, 5)
    db.close()
    db = new OrchestrationDb(databasePath)

    const snapshot = db.getRunCapacity(run.id)
    expect(snapshot.targetConcurrency).toBe(5)
    expect(snapshot.launchableTasks.map((candidate) => candidate.id)).toEqual([task.id])
  })

  it('surfaces user takeover and release-unknown without closing either terminal', () => {
    const { runId } = setup(2)
    const unknownTask = db!.createTask({ spec: 'unknown release', runId, capacityEligible: true })
    const userTask = db!.createTask({ spec: 'user takeover', runId, capacityEligible: true })
    const unknownDispatch = startAndSettle(unknownTask.id, 'term_unknown')
    const userDispatch = startAndSettle(userTask.id, 'term_user')
    db!.db
      .prepare(
        "UPDATE worker_terminal_resources SET release_state = 'unknown' WHERE owner_dispatch_id = ?"
      )
      .run(unknownDispatch)
    db!.db
      .prepare(
        "UPDATE worker_terminal_resources SET ownership_state = 'user_owned', release_state = 'retained', retained_reason = 'user_takeover' WHERE owner_dispatch_id = ?"
      )
      .run(userDispatch)

    const debt = db!.getRunCapacity(runId).settledTerminalDebt
    expect(debt).toEqual([
      expect.objectContaining({ dispatchId: unknownDispatch, terminalState: 'release_unknown' }),
      expect.objectContaining({
        dispatchId: userDispatch,
        terminalState: 'retained',
        retainedReason: 'user_takeover'
      })
    ])
  })
})
