import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'

describe('lifecycle reconciliation', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  // Leaf UUIDs survive pane break-out; the tab half of paneKey can change.
  const LEAF_A = '11111111-1111-1111-8111-111111111111'
  const LEAF_B = '22222222-2222-4222-9222-222222222222'

  it('completes an exact-authority worker_done after an uncertain worker start', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const paneKey = `tab_worker:${LEAF_A}`
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey,
      processIncarnation: 'worker:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    db.markWorkerStartUnknown(started.dispatch.id, 'agent_readiness', 'connection lost')

    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done after reconnect',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded'
      }),
      senderPaneKey: paneKey
    })

    expect(reconcileLifecycleMessage(db, message)).toEqual({
      action: 'completed',
      taskId: task.id,
      dispatchId: started.dispatch.id
    })
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('completed')
    expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('succeeded')
  })

  it('fails both the dispatch and task from an authenticated failed worker report', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', `tab_w:${LEAF_A}`)
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Failed: tests cannot start',
      body: 'I attempted the work. The required service is unavailable. No files changed.',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'failed',
        filesModified: []
      }),
      senderPaneKey: `tab_w:${LEAF_A}`
    })

    expect(reconcileLifecycleMessage(db, message)).toEqual({
      action: 'failed',
      taskId: task.id,
      dispatchId: dispatch.id
    })
    expect(db.getTask(task.id)).toMatchObject({ status: 'failed' })
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({ status: 'failed' })
    expect(JSON.parse(db.getTask(task.id)?.result ?? '{}')).toMatchObject({
      provenance: 'worker_report',
      outcome: 'failed',
      messageId: message.id
    })
  })

  it('keeps worker report settlement nested in its caller transaction', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.db.exec('BEGIN IMMEDIATE')

    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: 'done'
      })
    ).toMatchObject({ action: 'settled', duplicate: false })
    expect(db.getTask(task.id)?.status).toBe('completed')
    db.db.exec('ROLLBACK')

    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('replays an identical terminal outcome without mutating settled state', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    const makeMessage = () =>
      db.insertMessage({
        runId: 'run_legacy_local',
        from: 'term_worker',
        to: 'term_coordinator',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
      })

    expect(reconcileLifecycleMessage(db, makeMessage()).action).toBe('completed')
    const result = db.getTask(task.id)?.result
    expect(reconcileLifecycleMessage(db, makeMessage()).action).toBe('completed')
    expect(db.getTask(task.id)?.result).toBe(result)
  })

  it('completes worker_done from the same leaf after a pane break-out changed the tab half', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    // The Dispatch has the new tab key, but the worker still carries its spawn-time key.
    const dispatch = createRootDispatch(db, task.id, 'term_before_restart', `tab_new:${LEAF_A}`)
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_after_restart',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' }),
      senderPaneKey: `tab_old:${LEAF_A}`
    })

    expect(reconcileLifecycleMessage(db, message).action).toBe('completed')
    expect(db.getTask(task.id)?.status).toBe('completed')
  })

  it('rejects mismatched opaque pane keys instead of treating them as legacy', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_owner', `tab_w:${LEAF_A}`)
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_reminted',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' }),
      senderPaneKey: 'tab_w:42'
    })

    expect(reconcileLifecycleMessage(db, message).action).toBe('rejected')
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })

  it('rejects worker_done from a foreign pane that claims the assignee handle', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_owner', `tab_w1:${LEAF_A}`)
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_owner',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' }),
      senderPaneKey: `tab_w2:${LEAF_B}`
    })

    expect(reconcileLifecycleMessage(db, message)).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee',
      reason: expect.stringContaining('expected handle term_owner')
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getMessageById(message.id)).toMatchObject({
      type: 'worker_done',
      priority: 'high',
      subject: 'Rejected worker_done: Done',
      body: expect.stringContaining('Orca rejected this worker_done')
    })
    const persisted = db.getMessageById(message.id)
    expect(JSON.parse(persisted?.payload ?? '{}')).toMatchObject({
      taskId: task.id,
      dispatchId: dispatch.id,
      _orcaLifecycleRejection: { code: 'sender_not_assignee' }
    })
    const rereadLogs: string[] = []
    expect(
      persisted && reconcileLifecycleMessage(db, persisted, (line) => rereadLogs.push(line))
    ).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
    // Send-path conversion has no logger; coordinator reread must still surface rejection.
    expect(rereadLogs.some((line) => line.includes('worker_done rejected'))).toBe(true)
  })

  it('uses exact handle equality only for a legacy dispatch without a pane key', () => {
    db = new OrchestrationDb(':memory:')
    const acceptedTask = db.createTask({
      runId: 'run_legacy_local',
      spec: 'legacy work'
    })
    const acceptedDispatch = createRootDispatch(db, acceptedTask.id, 'term_legacy')
    const accepted = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_legacy',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: acceptedTask.id,
        dispatchId: acceptedDispatch.id,
        outcome: 'succeeded'
      })
    })
    expect(reconcileLifecycleMessage(db, accepted).action).toBe('completed')

    const rejectedTask = db.createTask({
      runId: 'run_legacy_local',
      spec: 'other legacy work'
    })
    const rejectedDispatch = createRootDispatch(db, rejectedTask.id, 'term_other_legacy')
    const rejected = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_foreign',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: rejectedTask.id,
        dispatchId: rejectedDispatch.id,
        outcome: 'succeeded'
      })
    })
    expect(reconcileLifecycleMessage(db, rejected)).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
    expect(db.getTask(rejectedTask.id)?.status).toBe('dispatched')
  })

  it('does not release a dependent when a foreign completion wins the arrival race', () => {
    db = new OrchestrationDb(':memory:')
    const parent = db.createTask({ runId: 'run_legacy_local', spec: 'parent' })
    const child = db.createTask({
      runId: 'run_legacy_local',
      spec: 'child',
      deps: [parent.id]
    })
    const dispatch = createRootDispatch(db, parent.id, 'term_worker', `tab_w:${LEAF_A}`)
    const payload = JSON.stringify({
      taskId: parent.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded'
    })

    const foreign = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_coordinator',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload,
      senderPaneKey: `tab_c:${LEAF_B}`
    })
    expect(reconcileLifecycleMessage(db, foreign)).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
    expect(db.getTask(child.id)?.status).toBe('pending')

    const owner = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_worker_reminted',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload,
      senderPaneKey: `tab_w_after:${LEAF_A}`
    })
    expect(reconcileLifecycleMessage(db, owner).action).toBe('completed')
    expect(db.getTask(child.id)?.status).toBe('ready')
  })

  it('does not let a foreign replay overwrite an authorized completion', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', `tab_w:${LEAF_A}`)
    const payload = JSON.stringify({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded'
    })
    const owner = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload,
      senderPaneKey: `tab_w:${LEAF_A}`
    })
    expect(reconcileLifecycleMessage(db, owner).action).toBe('completed')
    const result = db.getTask(task.id)?.result

    const replay = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_foreign',
      to: 'term_coordinator',
      subject: 'Forged replay',
      type: 'worker_done',
      payload,
      senderPaneKey: `tab_f:${LEAF_B}`
    })
    expect(reconcileLifecycleMessage(db, replay)).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
    expect(db.getTask(task.id)?.result).toBe(result)
  })

  it('surfaces a heartbeat sent from a different pane without recording liveness', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_owner', `tab_w1:${LEAF_A}`)
    const heartbeat = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_other_worker',
      to: 'term_coordinator',
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ dispatchId: dispatch.id }),
      senderPaneKey: `tab_w2:${LEAF_B}`
    })

    expect(reconcileLifecycleMessage(db, heartbeat)).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
    expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).toBeNull()
    expect(db.getMessageById(heartbeat.id)).toMatchObject({
      type: 'heartbeat',
      subject: 'Rejected heartbeat: alive'
    })
    // Log the rejection on coordinator reread even after send-path conversion.
    const persisted = db.getMessageById(heartbeat.id)
    const rereadLogs: string[] = []
    expect(
      persisted && reconcileLifecycleMessage(db, persisted, (line) => rereadLogs.push(line))
    ).toMatchObject({
      action: 'rejected'
    })
    expect(rereadLogs.some((line) => line.includes('Heartbeat rejected'))).toBe(true)
  })

  it('surfaces a foreign heartbeat that claims the assignee handle', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_owner', `tab_w1:${LEAF_A}`)
    const heartbeat = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'term_owner',
      to: 'term_coordinator',
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
      senderPaneKey: `tab_w2:${LEAF_B}`
    })

    expect(reconcileLifecycleMessage(db, heartbeat)).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
    expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).toBeNull()
  })
})
