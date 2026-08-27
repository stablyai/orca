import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

type TestSqlite = {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown }
}

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function sqliteFor(orchestrationDb: OrchestrationDb): TestSqlite {
  return (orchestrationDb as unknown as { db: TestSqlite }).db
}

function insertResource(
  orchestrationDb: OrchestrationDb,
  overrides: Partial<{
    id: string
    ownerDispatchId: string
    ownershipState: string
    releaseState: string
    worktreeId: string | null
  }> = {}
): void {
  sqliteFor(orchestrationDb)
    .prepare(
      `INSERT INTO worker_terminal_resources (
         id, origin_dispatch_id, owner_dispatch_id, terminal_handle, worktree_id,
         ownership_state, release_state
       ) VALUES (?, ?, ?, 'term-worker', ?, ?, ?)`
    )
    .run(
      overrides.id ?? 'wtr-worker',
      overrides.ownerDispatchId ?? 'ctx-worker',
      overrides.ownerDispatchId ?? 'ctx-worker',
      overrides.worktreeId ?? null,
      overrides.ownershipState ?? 'owned',
      overrides.releaseState ?? 'not_requested'
    )
}

describe('persisted Codex worker thread lifecycle', () => {
  it('records one exact Codex thread identity idempotently and rejects ambiguity', () => {
    db = new OrchestrationDb(':memory:')
    insertResource(db)

    expect(db.listWorkerTerminalResourcesAwaitingProviderSession()).toEqual([
      expect.objectContaining({ id: 'wtr-worker', owner_dispatch_id: 'ctx-worker' })
    ])
    expect(
      db.recordWorkerCodexThreadIdentity({
        dispatchId: 'ctx-worker',
        resourceId: 'wtr-worker',
        threadId: 'thread-worker',
        autoName: 'Implement worker lifecycle'
      })
    ).toMatchObject({
      codex_thread_id: 'thread-worker',
      codex_auto_name: 'Implement worker lifecycle',
      codex_name_state: 'pending',
      codex_archive_state: 'not_requested'
    })
    expect(db.listWorkerTerminalResourcesAwaitingProviderSession()).toEqual([])
    expect(
      db.recordWorkerCodexThreadIdentity({
        dispatchId: 'ctx-worker',
        resourceId: 'wtr-worker',
        threadId: 'thread-worker',
        autoName: 'Implement worker lifecycle'
      })
    ).toMatchObject({ codex_thread_id: 'thread-worker' })
    expect(() =>
      db!.recordWorkerCodexThreadIdentity({
        dispatchId: 'ctx-worker',
        resourceId: 'wtr-worker',
        threadId: 'thread-other',
        autoName: 'Wrong thread'
      })
    ).toThrow(/different Codex thread/i)
  })

  it('does not bind external or transferred terminal resources', () => {
    db = new OrchestrationDb(':memory:')
    insertResource(db, { id: 'wtr-external', ownershipState: 'external' })
    insertResource(db, {
      id: 'wtr-transferred',
      ownerDispatchId: 'ctx-new-owner',
      ownershipState: 'transferred'
    })

    expect(() =>
      db!.recordWorkerCodexThreadIdentity({
        dispatchId: 'ctx-worker',
        resourceId: 'wtr-external',
        threadId: 'thread-external',
        autoName: 'External'
      })
    ).toThrow(/owned disposable terminal/i)
    expect(() =>
      db!.recordWorkerCodexThreadIdentity({
        dispatchId: 'ctx-worker',
        resourceId: 'wtr-transferred',
        threadId: 'thread-transferred',
        autoName: 'Transferred'
      })
    ).toThrow(/owned disposable terminal/i)
  })

  it('persists name and archive outcomes for restart-safe retries', () => {
    db = new OrchestrationDb(':memory:')
    insertResource(db)
    db.recordWorkerCodexThreadIdentity({
      dispatchId: 'ctx-worker',
      resourceId: 'wtr-worker',
      threadId: 'thread-worker',
      autoName: 'Implement worker lifecycle'
    })

    db.markWorkerCodexThreadNameOutcome('wtr-worker', 'user_named')
    sqliteFor(db)
      .prepare(
        `UPDATE worker_terminal_resources
            SET ownership_state = 'released', release_state = 'released'
          WHERE id = 'wtr-worker'`
      )
      .run()
    db.requestWorkerCodexThreadArchive('ctx-worker', 'wtr-worker')

    expect(db.listWorkerCodexThreadLifecycleBacklog()).toEqual([
      expect.objectContaining({
        id: 'wtr-worker',
        codex_name_state: 'user_named',
        codex_archive_state: 'requested'
      })
    ])
    db.markWorkerCodexThreadArchived('wtr-worker')
    expect(db.listWorkerCodexThreadLifecycleBacklog()).toEqual([])
    expect(db.getWorkerTerminalResource('wtr-worker')).toMatchObject({
      codex_name_state: 'user_named',
      codex_archive_state: 'archived'
    })
  })

  it('finalizes only owned disposable resources after a proven worktree teardown', () => {
    db = new OrchestrationDb(':memory:')
    insertResource(db, { id: 'wtr-owned', worktreeId: 'repo::worker' })
    insertResource(db, {
      id: 'wtr-external',
      ownerDispatchId: 'ctx-external',
      worktreeId: 'repo::worker',
      ownershipState: 'external'
    })
    db.recordWorkerCodexThreadIdentity({
      dispatchId: 'ctx-worker',
      resourceId: 'wtr-owned',
      threadId: 'thread-worker',
      autoName: 'Worker'
    })

    expect(db.finalizeOwnedWorkerTerminalResourcesForRemovedWorktree('repo::worker')).toEqual([
      expect.objectContaining({
        id: 'wtr-owned',
        ownership_state: 'released',
        release_state: 'released',
        codex_archive_state: 'requested'
      })
    ])
    expect(db.getWorkerTerminalResource('wtr-external')).toMatchObject({
      ownership_state: 'external',
      release_state: 'not_requested'
    })
  })
})
