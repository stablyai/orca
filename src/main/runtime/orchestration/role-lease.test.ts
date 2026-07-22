import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  assertCoordinatorControlAllowed,
  canPerformCoordinatorControl,
  OrchestrationRoleDeniedError,
  resolveOrchestrationAuthority
} from './role-lease'

describe('ORCH-R15 role lease / post-worker_done quarantine', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function dispatchWorker(
    d: OrchestrationDb,
    opts: { handle: string; paneKey?: string; spec?: string } = {
      handle: 'term_worker'
    }
  ) {
    const task = d.createTask({ spec: opts.spec ?? 'do work' })
    const ctx = d.createDispatchContext(task.id, opts.handle, opts.paneKey)
    return { task, ctx }
  }

  it('keeps an active worker scoped: user follow-up before worker_done cannot task-create', () => {
    const d = createDb()
    const { ctx } = dispatchWorker(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })

    const authority = resolveOrchestrationAuthority(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })
    expect(authority).toMatchObject({ role: 'worker', dispatch: { id: ctx.id } })
    expect(canPerformCoordinatorControl(authority, 'taskCreate')).toBe(false)
    expect(canPerformCoordinatorControl(authority, 'ask')).toBe(true)
    expect(canPerformCoordinatorControl(authority, 'send.decision_gate')).toBe(true)
    expect(canPerformCoordinatorControl(authority, 'gateCreate')).toBe(false)

    expect(() =>
      assertCoordinatorControlAllowed(
        d,
        { handle: 'term_worker', paneKey: 'tab_w:leaf_w' },
        'taskCreate'
      )
    ).toThrow(OrchestrationRoleDeniedError)

    // Denial without mutation.
    expect(d.listTasks()).toHaveLength(1)
  })

  it('quarantines after accepted worker_done and denies coordinator control without mutation', () => {
    const d = createDb()
    const { task, ctx } = dispatchWorker(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })
    d.updateTaskStatus(task.id, 'completed', JSON.stringify({ ok: true }))
    d.completeDispatch(ctx.id)

    const authority = resolveOrchestrationAuthority(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })
    expect(authority.role).toBe('quarantined')
    if (authority.role !== 'quarantined') {
      throw new Error('expected quarantine')
    }
    expect(authority.lastDispatch.id).toBe(ctx.id)

    const beforeTasks = d.listTasks().length
    const beforeGates = d.listGates().length
    expect(() =>
      assertCoordinatorControlAllowed(
        d,
        { handle: 'term_worker', paneKey: 'tab_w:leaf_w' },
        'gateCreate'
      )
    ).toThrow(/post-worker_done quarantined/)
    expect(() =>
      assertCoordinatorControlAllowed(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' }, 'ask')
    ).toThrow(OrchestrationRoleDeniedError)
    expect(d.listTasks()).toHaveLength(beforeTasks)
    expect(d.listGates()).toHaveLength(beforeGates)
  })

  it('treats a stale/old inactive dispatch as quarantine, not active worker authority', () => {
    const d = createDb()
    const first = dispatchWorker(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' })
    d.updateTaskStatus(first.task.id, 'failed', JSON.stringify({ err: 'boom' }))
    d.failDispatch(first.ctx.id, 'boom')

    // Fresh task for someone else must not revive the old worker pane.
    const other = d.createTask({ spec: 'other' })
    d.createDispatchContext(other.id, 'term_other', 'tab_o:leaf_o')

    const authority = resolveOrchestrationAuthority(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })
    expect(authority.role).toBe('quarantined')
    if (authority.role === 'quarantined') {
      expect(authority.lastDispatch.id).toBe(first.ctx.id)
    }
  })

  it('follows same-pane handle remint for quarantine and active worker roles', () => {
    const d = createDb()
    const leaf = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const { ctx } = dispatchWorker(d, {
      handle: 'term_worker_old',
      paneKey: `tab_w:${leaf}`
    })

    // Reminted handle, same leaf — still the active worker.
    expect(
      resolveOrchestrationAuthority(d, {
        handle: 'term_worker_new',
        paneKey: `tab_w:${leaf}`
      })
    ).toMatchObject({ role: 'worker', dispatch: { id: ctx.id } })

    d.completeDispatch(ctx.id)
    d.updateTaskStatus(ctx.task_id, 'completed')

    // Reminted handle + tab break-out after completion stays quarantined via leaf identity.
    const remintedPane = `tab_other:${leaf}`
    expect(
      d.findLatestDispatchForAssignee({
        handle: 'term_worker_newer',
        paneKey: remintedPane
      })?.id
    ).toBe(ctx.id)
    expect(
      resolveOrchestrationAuthority(d, {
        handle: 'term_worker_newer',
        paneKey: remintedPane
      }).role
    ).toBe('quarantined')
  })

  it('requires an explicit coordinator role lease for handoff; then allows control', () => {
    const d = createDb()
    const { task, ctx } = dispatchWorker(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })
    d.updateTaskStatus(task.id, 'completed')
    d.completeDispatch(ctx.id)

    expect(() =>
      assertCoordinatorControlAllowed(
        d,
        { handle: 'term_worker', paneKey: 'tab_w:leaf_w' },
        'dispatch'
      )
    ).toThrow(OrchestrationRoleDeniedError)

    // Grantor must itself be allowed (unscoped / coordinator).
    const lease = d.grantCoordinatorRoleLease({
      subjectHandle: 'term_worker',
      subjectPaneKey: 'tab_w:leaf_w',
      grantedByHandle: 'term_coord'
    })

    const authority = resolveOrchestrationAuthority(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })
    expect(authority).toMatchObject({
      role: 'coordinator',
      lease: { id: lease.id, ceremony: 'explicit_handoff' }
    })
    expect(canPerformCoordinatorControl(authority, 'dispatch')).toBe(true)
    expect(canPerformCoordinatorControl(authority, 'taskCreate')).toBe(true)
  })

  it('persists explicit coordinator promotion across database reopen', () => {
    const dbPath = join(tmpdir(), `orca-role-lease-${randomUUID()}.sqlite`)
    db = new OrchestrationDb(dbPath)
    try {
      const { task, ctx } = dispatchWorker(db, {
        handle: 'term_worker',
        paneKey: 'tab_w:leaf_w'
      })
      db.updateTaskStatus(task.id, 'completed')
      db.completeDispatch(ctx.id)
      const lease = db.grantCoordinatorRoleLease({
        subjectHandle: 'term_worker',
        subjectPaneKey: 'tab_w:leaf_w',
        grantedByHandle: 'term_coord'
      })
      db.close()
      db = undefined

      db = new OrchestrationDb(dbPath)
      expect(
        resolveOrchestrationAuthority(db, {
          handle: 'term_worker',
          paneKey: 'tab_w:leaf_w'
        })
      ).toMatchObject({
        role: 'coordinator',
        lease: { id: lease.id, ceremony: 'explicit_handoff' }
      })
    } finally {
      db?.close()
      db = undefined
      rmSync(dbPath, { force: true })
    }
  })

  it('lets fresh redispatch restore worker scope over prior quarantine', () => {
    const d = createDb()
    const first = dispatchWorker(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' })
    d.updateTaskStatus(first.task.id, 'completed')
    d.completeDispatch(first.ctx.id)

    expect(
      resolveOrchestrationAuthority(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' }).role
    ).toBe('quarantined')

    const second = dispatchWorker(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w',
      spec: 'retry'
    })
    expect(
      resolveOrchestrationAuthority(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' })
    ).toMatchObject({ role: 'worker', dispatch: { id: second.ctx.id } })
  })

  it('allows identity-less bootstrap but fails closed after dispatch history exists', () => {
    const d = createDb()
    expect(resolveOrchestrationAuthority(d, {}).role).toBe('unscoped')
    expect(
      resolveOrchestrationAuthority(d, { handle: 'term_coord', paneKey: 'tab_c:leaf_c' }).role
    ).toBe('unscoped')

    dispatchWorker(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' })

    expect(resolveOrchestrationAuthority(d, {}).role).toBe('unidentified')
    expect(canPerformCoordinatorControl({ role: 'unidentified' }, 'taskCreate')).toBe(false)
    expect(canPerformCoordinatorControl({ role: 'unscoped' }, 'taskCreate')).toBe(true)
  })

  it('consumes a coordinator lease on fresh redispatch', () => {
    const d = createDb()
    const first = dispatchWorker(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' })
    d.updateTaskStatus(first.task.id, 'completed')
    d.completeDispatch(first.ctx.id)
    d.grantCoordinatorRoleLease({
      subjectHandle: 'term_worker',
      subjectPaneKey: 'tab_w:leaf_w',
      grantedByHandle: 'term_coord'
    })

    const second = dispatchWorker(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w',
      spec: 'redispatched work'
    })
    d.updateTaskStatus(second.task.id, 'completed')
    d.completeDispatch(second.ctx.id)

    expect(
      d.findActiveCoordinatorLease({
        handle: 'term_worker',
        paneKey: 'tab_w:leaf_w'
      })
    ).toBeUndefined()
    expect(
      resolveOrchestrationAuthority(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' }).role
    ).toBe('quarantined')
  })

  it('preserves worker quarantine evidence through task reset', () => {
    const d = createDb()
    const { task, ctx } = dispatchWorker(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })
    d.updateTaskStatus(task.id, 'completed')
    d.completeDispatch(ctx.id)

    d.resetTasks()

    expect(d.listTasks()).toHaveLength(0)
    expect(
      resolveOrchestrationAuthority(d, { handle: 'term_worker', paneKey: 'tab_w:leaf_w' }).role
    ).toBe('quarantined')
  })

  it('denies self-promotion grant while quarantined', () => {
    const d = createDb()
    const { task, ctx } = dispatchWorker(d, {
      handle: 'term_worker',
      paneKey: 'tab_w:leaf_w'
    })
    d.updateTaskStatus(task.id, 'completed')
    d.completeDispatch(ctx.id)

    expect(() =>
      assertCoordinatorControlAllowed(
        d,
        { handle: 'term_worker', paneKey: 'tab_w:leaf_w' },
        'roleLeaseGrant'
      )
    ).toThrow(OrchestrationRoleDeniedError)
    expect(d.findActiveCoordinatorLease({ handle: 'term_worker' })).toBeUndefined()
  })
})
