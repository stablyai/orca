import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

describe('OrchestrationDb worker Dispatch state', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('requeues an active Task before settling a worker whose terminal is missing', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'recover missing worker' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' }
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_missing',
      paneKey: 'tab_missing:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'pty-missing:22222222-2222-4222-8222-222222222222',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    expect(
      d.reconcileMissingWorkerTerminal(started.dispatch.id, 'worker terminal is no longer live')
    ).toMatchObject({
      state: 'abandoned',
      stage: 'terminal_missing',
      last_error: 'worker terminal is no longer live'
    })
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'failed',
      failure_count: 1,
      last_failure: 'worker terminal is no longer live'
    })
    expect(d.getTask(task.id)?.status).toBe('ready')

    d.reconcileMissingWorkerTerminal(started.dispatch.id, 'duplicate recovery')
    expect(d.getDispatchContextById(started.dispatch.id)?.failure_count).toBe(1)
    expect(d.getTask(task.id)?.status).toBe('ready')
  })

  it('allows retry only from the Task current terminal Dispatch', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'retry current' })
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const second = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      retryOf: first.dispatch.id,
      startOptions: {}
    })
    expect(second.dispatch.retry_of_dispatch_id).toBe(first.dispatch.id)
    d.failWorkerStart(second.dispatch.id, 'agent_readiness', 'second failed')

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      })
    ).toThrow('cannot retry')
    expect(
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: second.dispatch.id,
        startOptions: {}
      }).worker.state
    ).toBe('starting')
  })

  it('treats abandon of a superseded Dispatch as a no-op', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'stale abandon' })
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const second = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      retryOf: first.dispatch.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: second.dispatch.id,
      handle: 'term_replacement',
      paneKey: 'tab_replacement:leaf_replacement',
      processIncarnation: 'runtime:pty:2',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(second.dispatch.id)

    expect(d.abandonWorkerDispatch(first.dispatch.id, 'epoch_test')).toMatchObject({
      disposition: 'already_settled',
      worker: { state: 'failed' }
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getWorkerDispatch(second.dispatch.id)?.state).toBe('ready')
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: second.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'settled' })
    expect(d.getTask(task.id)?.status).toBe('completed')
  })

  it('lets the stop fence win before a late worker completion', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'race' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    expect(d.beginWorkerStop(started.dispatch.id, 'runtime_test').disposition).toBe('stopping')
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(d.settleWorkerStop(started.dispatch.id).state).toBe('stopped')
    expect(d.getTask(task.id)?.status).toBe('blocked')
  })

  it('allows explicit stop recovery from uncertain local and remote starts', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'uncertain local start' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.markWorkerStartUnknown(started.dispatch.id, 'agent_readiness', 'connection lost')

    expect(d.beginWorkerStop(started.dispatch.id, 'runtime_test')).toMatchObject({
      disposition: 'stopping',
      worker: { state: 'stopping' }
    })

    d.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: 'ctx_remote_unknown',
      taskId: 'task_remote_unknown',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: 'worker_epoch',
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'remote_unknown_start',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_unknown_payload'
      }
    })
    d.recordRemoteAttachmentStage({
      dispatchId: 'ctx_remote_unknown',
      stage: 'agent_readiness',
      state: 'start_unknown',
      terminalHandle: 'term_remote_worker'
    })

    expect(d.beginRemoteAttachmentStop('ctx_remote_unknown')).toMatchObject({
      state: 'stopping',
      stage: 'stop_requested',
      capability_hash: null
    })
  })

  it.each(['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'] as const)(
    'keeps a %s remote attachment authoritative for pane occupancy',
    (state) => {
      const d = createDb()
      const paneKey = 'tab_remote:11111111-1111-4111-8111-111111111111'
      const attach = (dispatchId: string): void => {
        d.createRemoteDispatchAttachment({
          runId: 'run-home',
          dispatchId,
          taskId: `task_${dispatchId}`,
          homePeerFingerprint: 'home_peer',
          protocolVersion: 1,
          runtimeEpoch: 'worker_epoch',
          mutationReceipt: {
            callerFingerprint: 'home_peer',
            requestId: `request_${dispatchId}`,
            method: 'orchestration.federationAttachStart',
            payloadHash: `payload_${dispatchId}`
          }
        })
      }

      attach('ctx_remote_owner')
      d.prepareRemoteAttachmentAuthority({
        dispatchId: 'ctx_remote_owner',
        paneKey,
        processIncarnation: 'process_owner',
        worktreeId: 'repo::worktree',
        terminalHandle: 'term_owner',
        setupState: 'not_applicable',
        effects: []
      })
      d.db
        .prepare('UPDATE remote_dispatch_attachments SET state = ? WHERE dispatch_id = ?')
        .run(state, 'ctx_remote_owner')
      attach('ctx_remote_contender')

      expect(() =>
        d.prepareRemoteAttachmentAuthority({
          dispatchId: 'ctx_remote_contender',
          paneKey,
          processIncarnation: 'process_contender',
          worktreeId: 'repo::worktree',
          terminalHandle: 'term_contender',
          setupState: 'not_applicable',
          effects: []
        })
      ).toThrow('already has active remote Dispatch ctx_remote_owner')
      expect(d.getRemoteDispatchAttachment('ctx_remote_contender')).toMatchObject({
        state: 'starting',
        pane_key: null,
        terminal_handle: null
      })
      expect(d.getWorkerTerminalResourceByOwner('ctx_remote_contender')).toBeUndefined()
    }
  )

  it('bounds remote attachment lookup across pane remints and malformed suffix collisions', () => {
    const d = createDb()
    const leafId = '11111111-1111-4111-8111-111111111111'
    const attach = (dispatchId: string, paneKey: string): void => {
      d.createRemoteDispatchAttachment({
        runId: 'run-home',
        dispatchId,
        taskId: `task_${dispatchId}`,
        homePeerFingerprint: 'home_peer',
        protocolVersion: 1,
        runtimeEpoch: 'worker_epoch',
        mutationReceipt: {
          callerFingerprint: 'home_peer',
          requestId: `request_${dispatchId}`,
          method: 'orchestration.federationAttachStart',
          payloadHash: `payload_${dispatchId}`
        }
      })
      d.prepareRemoteAttachmentAuthority({
        dispatchId,
        paneKey,
        processIncarnation: `process_${dispatchId}`,
        worktreeId: 'repo::worktree',
        terminalHandle: `term_${dispatchId}`,
        setupState: 'not_applicable',
        effects: []
      })
    }

    attach('ctx_valid_old', `tab_old:${leafId}`)
    for (let index = 0; index < 64; index += 1) {
      const dispatchId = `ctx_malformed_${index}`
      attach(dispatchId, `:${leafId}`)
      if (index < 63) {
        d.failRemoteAttachment(dispatchId, 'fixture_retired', 'Superseded fixture row.', false)
      }
    }

    expect(d.findActiveRemoteAttachmentForPane(`tab_reminted:${leafId}`)?.dispatch_id).toBe(
      'ctx_valid_old'
    )
    d.failRemoteAttachment('ctx_valid_old', 'fixture_retired', 'Pane reminted.', false)
    attach('ctx_valid_new', `tab_new:${leafId}`)
    expect(d.findActiveRemoteAttachmentForPane(`tab_reminted:${leafId}`)?.dispatch_id).toBe(
      'ctx_valid_new'
    )
    expect(d.findActiveRemoteAttachmentForPane(`tab_old:${leafId}`)?.dispatch_id).toBe(
      'ctx_valid_new'
    )
  })

  it('returns already-settled when completion wins before stop', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'race' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'settled' })

    expect(d.beginWorkerStop(started.dispatch.id, 'runtime_test')).toMatchObject({
      disposition: 'already_settled',
      worker: { state: 'succeeded' }
    })
  })
})
