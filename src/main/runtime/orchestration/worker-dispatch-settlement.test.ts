import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { settleActiveDispatchesForTask } from './db/dispatch-context/dispatch-completion'
import { mintStructuredWorkerHandle } from '../structured-worker-identity'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from '../runtime-legacy-worker-terminal-recovery-persistence'

describe('settled assignment worker recovery', () => {
  let directory: string
  let databasePath: string
  let db: OrchestrationDb
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-worker-settlement-'))
    databasePath = join(directory, 'orchestration.db')
    db = new OrchestrationDb(databasePath)
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function worker(handle: string | null = 'term_worker') {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'assignment settlement' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    if (handle) {
      db.prepareStartingWorkerAuthority({
        dispatchId: dispatch.id,
        handle,
        paneKey: `tab_${dispatch.id}:${randomUUID()}`,
        processIncarnation: 'pty-1:22222222-2222-4222-8222-222222222222',
        worktreeId: 'repo::/deleted/worktree',
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'created'
      })
      db.markWorkerDispatchReady(dispatch.id)
    }
    return { taskId: task.id, dispatchId: dispatch.id }
  }

  it('settles completion atomically without claiming process exit or releasing the terminal', () => {
    const { dispatchId } = worker()
    const resourceBefore = db.getWorkerTerminalResourceByOwner(dispatchId)
    db.completeDispatch(dispatchId)

    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'abandoned',
      stage: 'assignment_settled',
      last_error: null
    })
    expect(db.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toEqual(resourceBefore)
  })

  it.each(['completed', 'failed'] as const)(
    'settles workers when their task assignments are %s',
    (status) => {
      const { taskId, dispatchId } = worker()
      settleActiveDispatchesForTask(db, taskId, status, 'assignment failed')

      expect(db.getDispatchContextById(dispatchId)?.status).toBe(status)
      expect(db.getWorkerDispatch(dispatchId)?.state).toBe('abandoned')
      expect(db.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
    }
  )

  it('preserves the actual worker report outcome', () => {
    const { taskId, dispatchId } = worker()
    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: '{}' })
    ).toMatchObject({ action: 'settled' })
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    expect(db.getTask(taskId)?.status).toBe('completed')
  })

  it('bounds the release backlog probe without truncating actual release reconciliation', () => {
    const first = worker('term_first')
    const second = worker('term_second')
    worker('term_not_requested')
    db.db
      .prepare(
        `UPDATE worker_terminal_resources SET release_state = ?, release_requested_at = ?
         WHERE owner_dispatch_id = ?`
      )
      .run('requested', '2026-01-01', first.dispatchId)
    db.db
      .prepare(
        `UPDATE worker_terminal_resources SET release_state = ?, release_requested_at = ?
         WHERE owner_dispatch_id = ?`
      )
      .run('releasing', '2026-01-02', second.dispatchId)
    const prepare = vi.spyOn(db.db, 'prepare')
    expect(db.listWorkerTerminalReleaseBacklog(1).map((row) => row.owner_dispatch_id)).toEqual([
      first.dispatchId
    ])
    expect(db.listWorkerTerminalReleaseBacklog().map((row) => row.owner_dispatch_id)).toEqual([
      first.dispatchId,
      second.dispatchId
    ])
    const query = prepare.mock.calls[0]?.[0]
    if (typeof query !== 'string') {
      throw new Error('Release backlog query was not prepared')
    }
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(1)
    expect(JSON.stringify(plan)).toContain('idx_worker_terminal_resources_release')
  })

  it('reads only requested recovery assignments through indexed lookups and one SQL shape', () => {
    const first = worker('term_first')
    const second = worker('term_second')
    worker('term_not_requested')
    const prepare = vi.spyOn(db.db, 'prepare')
    expect(
      db.listLegacyWorkerTerminalRecoveryRows([first.dispatchId]).map((row) => row.dispatch_id)
    ).toEqual([first.dispatchId])
    expect(
      db
        .listLegacyWorkerTerminalRecoveryRows([first.dispatchId, second.dispatchId])
        .map((row) => row.dispatch_id)
    ).toEqual([first.dispatchId, second.dispatchId])
    expect(db.listLegacyWorkerTerminalRecoveryRows([])).toEqual([])
    expect(prepare).toHaveBeenCalledTimes(2)
    const query = prepare.mock.calls[0]?.[0]
    expect(prepare.mock.calls[1]?.[0]).toBe(query)
    if (typeof query !== 'string') {
      throw new Error('Recovery query was not prepared')
    }
    const plan = db.db
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(JSON.stringify([first.dispatchId]))
    const details = plan.map((row) => {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('detail' in row) ||
        typeof row.detail !== 'string'
      ) {
        throw new Error('Invalid query plan')
      }
      return row.detail
    })
    expect(
      details.some(
        (detail) => detail.startsWith('SEARCH wd USING INDEX') && detail.includes('dispatch_id=?')
      )
    ).toBe(true)
    expect(
      details.some(
        (detail) => detail.startsWith('SEARCH dc USING INDEX') && detail.includes('id=?')
      )
    ).toBe(true)
    expect(details.some((detail) => /^SCAN (wd|dc)\b/.test(detail))).toBe(false)
  })

  it('preserves retry failure when SQL cannot be read, then recovers after the database reopens', () => {
    const { dispatchId } = worker()
    const recovery = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
      () => null,
      () => db,
      () => null
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      db.close()
      expect(() => recovery.prepare([dispatchId])).toThrow()
      db = new OrchestrationDb(databasePath)
      expect(
        recovery.prepare([dispatchId]).candidates.map((candidate) => candidate.dispatchId)
      ).toEqual([dispatchId])
    } finally {
      warning.mockRestore()
    }
  })

  it('rolls back dispatch completion when worker settlement cannot be committed', () => {
    const { dispatchId } = worker()
    db.db.exec(`CREATE TRIGGER reject_worker_settlement BEFORE UPDATE OF state ON worker_dispatches
      WHEN NEW.state = 'abandoned' BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END;`)

    expect(() => db.completeDispatch(dispatchId)).toThrow('injected settlement failure')
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  })

  it('rolls back all task assignments when any worker settlement fails', () => {
    const first = worker('term_first')
    const second = worker('term_second')
    db.db
      .prepare('UPDATE dispatch_contexts SET task_id = ? WHERE id = ?')
      .run(first.taskId, second.dispatchId)
    db.db
      .prepare('UPDATE worker_dispatches SET stage = ? WHERE dispatch_id = ?')
      .run('reject_fixture', second.dispatchId)
    db.db.exec(`CREATE TRIGGER reject_second_worker BEFORE UPDATE OF state ON worker_dispatches
      WHEN OLD.stage = 'reject_fixture' AND NEW.state = 'abandoned'
      BEGIN SELECT RAISE(ABORT, 'injected second settlement failure'); END;`)

    expect(() => settleActiveDispatchesForTask(db, first.taskId, 'completed')).toThrow(
      'injected second settlement failure'
    )
    for (const dispatchId of [first.dispatchId, second.dispatchId]) {
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    }
  })

  it.each(['completed', 'failed', 'circuit_broken'] as const)(
    'repairs historical %s assignments on reopen for PTY, structured and handle-less workers',
    (status) => {
      const dispatchIds: string[] = []
      for (const state of ['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown']) {
        for (const handle of ['term_worker', mintStructuredWorkerHandle(), null]) {
          const { dispatchId } = worker(handle)
          dispatchIds.push(dispatchId)
          // Reproduce rows written before assignment and worker settlement shared a transaction.
          db.db
            .prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?')
            .run(status, dispatchId)
          db.db
            .prepare('UPDATE worker_dispatches SET state = ?, last_error = ? WHERE dispatch_id = ?')
            .run(state, 'historical diagnostic', dispatchId)
        }
      }
      db.close()
      db = new OrchestrationDb(databasePath)

      expect(db.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
      for (const dispatchId of dispatchIds) {
        expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
          state: 'abandoned',
          stage: 'assignment_settled',
          last_error: 'historical diagnostic'
        })
        expect(db.getDispatchContextById(dispatchId)?.status).toBe(status)
      }
    }
  )

  it('keeps uncertain workers with pending assignments recoverable across reopen', () => {
    const pending = worker(null)
    db.markWorkerStartUnknown(pending.dispatchId, 'agent_readiness', 'lost contact')
    const dispatched = worker()
    db.beginWorkerStop(dispatched.dispatchId, 'old-runtime')
    db.markWorkerStopUnknown(dispatched.dispatchId, 'host unavailable')
    db.close()
    db = new OrchestrationDb(databasePath)

    expect(db.getWorkerDispatch(pending.dispatchId)?.state).toBe('start_unknown')
    expect(db.getWorkerDispatch(dispatched.dispatchId)?.state).toBe('stop_unknown')
    expect(db.listLegacyWorkerTerminalRecoveryRows()).toHaveLength(2)
  })
})
