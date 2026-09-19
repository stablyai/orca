import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const PANE_W = 'tab_w:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_R = 'tab_r:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('an unproven worker stop', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function localWorker() {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'local work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_w',
      paneKey: PANE_W,
      processIncarnation: 'inc1',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_configured'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return { task, dispatch, capability }
  }

  function verifyLocal(dispatchId: string, capability: string) {
    return db.verifyDispatchCapability({
      dispatchId,
      capability,
      paneKey: PANE_W,
      processIncarnation: 'inc1'
    })
  }

  it('keeps the in-flight stop fence, then hands the capability back on stop_unknown', () => {
    const { dispatch, capability } = localWorker()

    db.beginWorkerStop(dispatch.id, 'epoch_home')
    // Intent still fences the worker while the stop is in flight.
    expect(verifyLocal(dispatch.id, capability)).toMatchObject({ valid: false })
    expect(db.getDispatchContextById(dispatch.id)?.capability_revoked_at).toBeTruthy()

    db.markWorkerStopUnknown(dispatch.id, 'the worker terminal is external; no terminal was closed')
    expect(db.getDispatchContextById(dispatch.id)?.capability_revoked_at).toBeNull()
    expect(verifyLocal(dispatch.id, capability)).toEqual({ valid: true })
  })

  it('keeps the revocation when the stop is proven', () => {
    const { dispatch, capability } = localWorker()

    db.beginWorkerStop(dispatch.id, 'epoch_home')
    db.settleWorkerStop(dispatch.id)

    expect(db.getDispatchContextById(dispatch.id)?.capability_revoked_at).toBeTruthy()
    expect(verifyLocal(dispatch.id, capability)).toMatchObject({ valid: false })
  })

  it('does not restore the capability onto an already settled dispatch', () => {
    const { dispatch } = localWorker()

    db.beginWorkerStop(dispatch.id, 'epoch_home')
    // A racing event settled the dispatch while the worker row still reads stopping.
    db.db.prepare("UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?").run(dispatch.id)
    db.markWorkerStopUnknown(dispatch.id, 'the execution host did not answer')

    expect(db.getDispatchContextById(dispatch.id)?.capability_revoked_at).toBeTruthy()
  })

  it('lets a succeeded worker report settle a dispatch the unproven stop left blocked', () => {
    const { task, dispatch } = localWorker()

    db.beginWorkerStop(dispatch.id, 'epoch_home')
    db.markWorkerStopUnknown(dispatch.id, 'the worker terminal is external; no terminal was closed')

    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: '{"summary":"done"}'
      })
    ).toMatchObject({ action: 'settled' })
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: 'succeeded',
      last_error: null
    })
  })

  it('lets a succeeded report settle while a legacy sibling keeps the task dispatched', () => {
    const { task, dispatch } = localWorker()

    // A fresh DB cannot open two dispatches on one task, but a migrated row can hold the
    // shape: the context-only sibling keeps the task dispatched through the unproven stop.
    db.db
      .prepare(
        "INSERT INTO dispatch_contexts (id, task_id, status, depth) VALUES (?, ?, 'dispatched', 0)"
      )
      .run('ctx_sibling', task.id)
    db.beginWorkerStop(dispatch.id, 'epoch_home')
    db.markWorkerStopUnknown(dispatch.id, 'the execution host did not answer')
    expect(db.getTask(task.id)?.status).toBe('dispatched')

    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: '{"summary":"done"}'
      })
    ).toMatchObject({ action: 'settled' })
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: 'succeeded',
      last_error: null
    })
  })

  it('lets a failed worker report settle a dispatch the unproven stop left blocked', () => {
    const { task, dispatch } = localWorker()

    db.beginWorkerStop(dispatch.id, 'epoch_home')
    db.markWorkerStopUnknown(dispatch.id, 'the worker terminal is external; no terminal was closed')

    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'failed',
        result: 'worker crashed'
      })
    ).toMatchObject({ action: 'settled' })
    expect(db.getTask(task.id)?.status).toBe('failed')
    expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('failed')
  })

  it('still rejects a worker report while the stop is in flight', () => {
    const { task, dispatch } = localWorker()

    db.beginWorkerStop(dispatch.id, 'epoch_home')

    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
  })
})

describe('an unproven remote attachment stop', () => {
  let db: OrchestrationDb
  let remoteSequence = 0
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    remoteSequence = 0
  })
  afterEach(() => db.close())

  function remoteAttachment() {
    const dispatchId = `ctx_remote_${++remoteSequence}`
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId,
      taskId: `task_${dispatchId}`,
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: 'worker_epoch',
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: `req_${dispatchId}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `hash_${dispatchId}`
      }
    })
    const capability = db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: PANE_R,
      processIncarnation: 'inc_remote',
      worktreeId: 'wt_remote',
      terminalHandle: 'term_remote',
      setupState: 'not_applicable',
      effects: []
    })
    db.markRemoteAttachmentReady(dispatchId)
    return { dispatchId, capability }
  }

  function verifyRemote(dispatchId: string, capability: string) {
    return db.verifyRemoteAttachmentAuthority({
      dispatchId,
      capability,
      paneKey: PANE_R,
      processIncarnation: 'inc_remote'
    })
  }

  it('keeps the capability hash through the intent and fences it on state instead', () => {
    const { dispatchId, capability } = remoteAttachment()

    db.beginRemoteAttachmentStop(dispatchId)
    const stopping = db.getRemoteDispatchAttachment(dispatchId)
    expect(stopping?.state).toBe('stopping')
    expect(stopping?.capability_hash).toBeTruthy()
    // The in-flight stop is fenced by state, not by a missing hash.
    expect(verifyRemote(dispatchId, capability)).toBe(false)
  })

  it('un-mutes the worker when the stop proves nothing', () => {
    const { dispatchId, capability } = remoteAttachment()

    db.beginRemoteAttachmentStop(dispatchId)
    db.markRemoteAttachmentStopUnknown(
      dispatchId,
      'the worker terminal is external; no terminal was closed'
    )

    expect(verifyRemote(dispatchId, capability)).toBe(true)
  })

  it('clears the hash when the stop is proven', () => {
    const { dispatchId, capability } = remoteAttachment()

    db.beginRemoteAttachmentStop(dispatchId)
    db.settleRemoteAttachmentStop(dispatchId)

    expect(db.getRemoteDispatchAttachment(dispatchId)?.capability_hash).toBeNull()
    expect(verifyRemote(dispatchId, capability)).toBe(false)
  })

  it('lets a worker_done relay settle a stop_unknown attachment', () => {
    const { dispatchId } = remoteAttachment()

    db.beginRemoteAttachmentStop(dispatchId)
    db.markRemoteAttachmentStopUnknown(dispatchId, 'no terminal was closed')
    db.settleRemoteAttachmentInRelayTransaction(dispatchId, 'succeeded')

    expect(db.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      state: 'succeeded',
      capability_hash: null,
      last_error: null
    })
  })

  it('still refuses a relay settle while the stop is in flight', () => {
    const { dispatchId } = remoteAttachment()

    db.beginRemoteAttachmentStop(dispatchId)

    expect(() => db.settleRemoteAttachmentInRelayTransaction(dispatchId, 'succeeded')).toThrowError(
      expect.objectContaining({ code: 'request_mismatch' })
    )
  })

  it('accepts a legacy-protocol worker_done enqueue from a stop_unknown attachment', () => {
    const { dispatchId } = remoteAttachment()

    db.beginRemoteAttachmentStop(dispatchId)
    db.markRemoteAttachmentStopUnknown(dispatchId, 'no terminal was closed')

    expect(() =>
      db.enqueueFederationRelay({
        dispatchId,
        direction: 'to_home',
        kind: 'worker_done',
        payload: '{"outcome":"succeeded"}',
        settleRemoteOutcome: 'succeeded'
      })
    ).not.toThrow()
    expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('succeeded')
  })

  it('re-asserts revocation when a late remote report proves the stop after all', () => {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'federated work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_w',
      paneKey: PANE_W,
      processIncarnation: 'inc1',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_configured'
    })
    db.markWorkerDispatchReady(dispatch.id)
    db.db
      .prepare(
        `INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint)
         VALUES (?, 'env_1', 'remote env', 'peer_1')`
      )
      .run(dispatch.id)

    db.beginWorkerStop(dispatch.id, 'epoch_home')
    db.markWorkerStopUnknown(dispatch.id, 'the remote did not answer')
    expect(db.getDispatchContextById(dispatch.id)?.capability_revoked_at).toBeNull()

    db.reconcileFederatedWorkerStop(dispatch.id)
    expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('stopped')
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'failed',
      last_failure: 'stopped'
    })
    expect(db.getDispatchContextById(dispatch.id)?.capability_revoked_at).toBeTruthy()
  })
})
