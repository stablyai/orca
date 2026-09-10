import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const launchProfile = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol',
  effort: 'high',
  permissionMode: 'yolo',
  routeRef: 'route:1'
}

describe('Maestro terminal lease store', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('replays one reservation without creating a duplicate lease', () => {
    db = new OrchestrationDb(':memory:')
    const params = {
      requestId: 'attempt:1',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: 'run_1',
      taskId: 'ORC-06C',
      attemptId: 'attempt-1',
      role: 'worker' as const,
      title: 'ORC-06C · worker · Codex',
      launchProfile,
      spawnedBy: 'coordinator:g3',
      ownerPrincipal: 'worker:attempt-1',
      retentionPolicy: 'auto_release' as const
    }
    const first = db.reserveMaestroTerminalLease(params)
    const replay = db.reserveMaestroTerminalLease(params)

    expect(replay.id).toBe(first.id)
    expect(
      (
        db.db.prepare('SELECT count(*) AS count FROM maestro_terminal_leases').get() as {
          count: number
        }
      ).count
    ).toBe(1)
  })

  it('refuses to remint a reserved lease onto another incarnation', () => {
    db = new OrchestrationDb(':memory:')
    const lease = db.reserveMaestroTerminalLease({
      requestId: 'attempt:2',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: 'run_1',
      attemptId: 'attempt-2',
      role: 'worker',
      title: 'Task · worker · Codex',
      launchProfile,
      spawnedBy: 'coordinator:g3',
      ownerPrincipal: 'worker:attempt-2',
      retentionPolicy: 'retain'
    })
    db.attachMaestroTerminalLease({
      leaseId: lease.id,
      terminalHandle: 'term_1',
      tabId: 'tab_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty:1',
      processRootId: 'pid:1'
    })

    expect(() =>
      db!.attachMaestroTerminalLease({
        leaseId: lease.id,
        terminalHandle: 'term_2',
        tabId: 'tab_2',
        paneKey: 'tab_2:leaf_2',
        ptyIncarnation: 'pty:2',
        processRootId: 'pid:2'
      })
    ).toThrow(/another terminal incarnation/)
  })

  it('allows only one cleanup ledger to own a live terminal incarnation', () => {
    db = new OrchestrationDb(':memory:')
    const reserve = (requestId: string) =>
      db!.reserveMaestroTerminalLease({
        requestId,
        executionHostId: 'local',
        workspaceKey: 'folder:one',
        runId: 'run_1',
        taskId: 'task_1',
        attemptId: requestId,
        role: 'worker',
        title: 'Task · worker · Codex',
        launchProfile,
        spawnedBy: 'coordinator:g3',
        ownerPrincipal: requestId,
        retentionPolicy: 'retain'
      })
    const first = reserve('owner:first')
    const second = reserve('owner:second')
    const identity = {
      terminalHandle: 'term_owned',
      tabId: 'tab_owned',
      paneKey: 'tab_owned:leaf_1',
      ptyIncarnation: 'pty:owned',
      processRootId: 'pid:owned'
    }
    db.attachMaestroTerminalLease({ leaseId: first.id, ...identity })

    expect(() => db!.attachMaestroTerminalLease({ leaseId: second.id, ...identity })).toThrow(
      /already owned/
    )
  })

  it('resolves a tab fallback only for the exact terminal incarnation', () => {
    db = new OrchestrationDb(':memory:')
    const reserve = (requestId: string, attemptId: string) =>
      db!.reserveMaestroTerminalLease({
        requestId,
        executionHostId: 'local',
        workspaceKey: 'folder:one',
        runId: 'run_1',
        attemptId,
        role: 'worker',
        title: attemptId,
        launchProfile,
        spawnedBy: 'coordinator:g1',
        ownerPrincipal: attemptId,
        retentionPolicy: 'retain'
      })
    const first = reserve('attempt:tab:first', 'attempt-tab-first')
    const second = reserve('attempt:tab:second', 'attempt-tab-second')
    db.attachMaestroTerminalLease({
      leaseId: first.id,
      terminalHandle: 'term_first',
      tabId: 'tab_shared',
      paneKey: 'tab_shared:leaf_first',
      ptyIncarnation: 'pty_first:inc_first',
      processRootId: 'pty_first'
    })
    db.attachMaestroTerminalLease({
      leaseId: second.id,
      terminalHandle: 'term_second',
      tabId: 'tab_shared',
      paneKey: 'tab_shared:leaf_second',
      ptyIncarnation: 'pty_second:inc_second',
      processRootId: 'pty_second'
    })

    expect(
      db.getMaestroTerminalLeaseByTab('local', 'folder:one', 'tab_shared', 'pty_first:inc_first')
        ?.id
    ).toBe(first.id)
    expect(
      db.getMaestroTerminalLeaseByTab(
        'local',
        'folder:one',
        'tab_shared',
        'pty_missing:inc_missing'
      )
    ).toBeUndefined()
  })

  it('reports an input replay without minting another receipt', () => {
    db = new OrchestrationDb(':memory:')
    const lease = db.reserveMaestroTerminalLease({
      requestId: 'attempt:input',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: 'run_1',
      attemptId: 'attempt-input',
      role: 'worker',
      title: 'Task · worker · Codex',
      launchProfile,
      spawnedBy: 'coordinator:g3',
      ownerPrincipal: 'worker:attempt-input',
      retentionPolicy: 'retain'
    })
    db.attachMaestroTerminalLease({
      leaseId: lease.id,
      terminalHandle: 'term_input',
      tabId: 'tab_input',
      paneKey: 'tab_input:leaf_1',
      ptyIncarnation: 'pty:input',
      processRootId: 'pid:input'
    })
    db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'ready' })
    const envelope = {
      commandId: 'command:input',
      idempotencyKey: 'input:one',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      enqueueSequence: 1,
      sender: {
        principalId: 'worker:attempt-input',
        authority: 'worker' as const,
        runId: 'run_1',
        coordinatorGeneration: null
      },
      leaseId: lease.id,
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      terminalHandle: 'term_input',
      tabId: 'tab_input',
      ptyIncarnation: 'pty:input',
      expectedLifecycleState: 'ready' as const,
      observedInputSurface: 'ready_prompt' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedGraphRevision: null
    }

    expect(db.acceptMaestroTerminalInput(envelope).replayed).toBe(false)
    expect(db.acceptMaestroTerminalInput(envelope)).toMatchObject({
      replayed: true,
      receipt: { commandId: 'command:input', state: 'accepted' }
    })
  })

  it('does not mirror worker release without an exact cleanup receipt', () => {
    db = new OrchestrationDb(':memory:')
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
          id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
          process_incarnation, ownership_state, release_state
        ) VALUES ('wtr_1', 'ctx_1', 'ctx_1', 'term_1', 'tab_1:leaf_1', 'pty:1', 'owned', 'requested')`
      )
      .run()
    const lease = db.reserveMaestroTerminalLease({
      requestId: 'worker:ctx_1',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: 'run_1',
      taskId: 'ORC-06C',
      attemptId: 'attempt-release',
      role: 'worker',
      workerTerminalResourceId: 'wtr_1',
      title: 'ORC-06C · worker · Codex',
      launchProfile,
      spawnedBy: 'coordinator:g1',
      ownerPrincipal: 'dispatch:ctx_1',
      retentionPolicy: 'auto_release'
    })
    db.attachMaestroTerminalLease({
      leaseId: lease.id,
      terminalHandle: 'term_1',
      tabId: 'tab_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty:1',
      processRootId: 'pty'
    })
    db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'ready' })
    db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'active' })

    db.settleWorkerTerminalRelease({
      resourceId: 'wtr_1',
      ownerDispatchId: 'ctx_1',
      processIncarnation: 'pty:1'
    })

    expect(db.getMaestroTerminalLease(lease.id)).toMatchObject({
      lifecycleState: 'outcome_unknown',
      cleanupReceipt: null
    })
  })

  it('does not settle a replacement incarnation through a stale release identity', () => {
    db = new OrchestrationDb(':memory:')
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
          id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
          process_incarnation, ownership_state, release_state
        ) VALUES ('wtr_fenced', 'ctx_old', 'ctx_new', 'term_1', 'tab_1:leaf_1', 'pty:new', 'owned', 'requested')`
      )
      .run()

    const stale = db.settleWorkerTerminalRelease({
      resourceId: 'wtr_fenced',
      ownerDispatchId: 'ctx_old',
      processIncarnation: 'pty:old'
    })
    expect(stale).toMatchObject({
      owner_dispatch_id: 'ctx_new',
      process_incarnation: 'pty:new',
      release_state: 'requested'
    })

    expect(
      db.settleWorkerTerminalRelease({
        resourceId: 'wtr_fenced',
        ownerDispatchId: 'ctx_new',
        processIncarnation: 'pty:new'
      }).release_state
    ).toBe('released')
  })

  it('atomically supersedes an exact worker attempt and replays its receipt', () => {
    db = new OrchestrationDb(':memory:')
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
          id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
          process_incarnation, ownership_state, release_state
        ) VALUES ('wtr_transfer', 'ctx_old', 'ctx_old', 'term_1', 'tab_1:leaf_1', 'pty:1', 'owned', 'not_requested')`
      )
      .run()
    const predecessor = db.reserveMaestroTerminalLease({
      requestId: 'worker:ctx_old',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: 'run_1',
      taskId: 'task_1',
      attemptId: 'attempt_1',
      role: 'worker',
      workerTerminalResourceId: 'wtr_transfer',
      title: 'task_1 · worker · Codex',
      launchProfile,
      spawnedBy: 'coordinator:g1',
      ownerPrincipal: 'dispatch:ctx_old',
      retentionPolicy: 'auto_release'
    })
    db.attachMaestroTerminalLease({
      leaseId: predecessor.id,
      terminalHandle: 'term_1',
      tabId: 'tab_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty:1',
      processRootId: 'pid:1'
    })
    db.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'ready' })
    db.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'active' })

    const params = {
      requestId: 'transfer:1',
      predecessorLeaseId: predecessor.id,
      successorRequestId: 'worker:ctx_new',
      kind: 'strict_retry' as const,
      successorDispatchId: 'ctx_new',
      runId: 'run_1',
      taskId: 'task_1',
      attemptId: 'attempt_1',
      terminalHandle: 'term_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty:1',
      processRootId: 'pid:1',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      hostScope: null,
      predecessorOwnerPrincipal: 'dispatch:ctx_old',
      successorOwnerPrincipal: 'dispatch:ctx_new',
      coordinatorGeneration: null,
      retentionPolicy: 'auto_release' as const,
      title: 'task_1 · worker · Codex',
      launchProfile,
      spawnedBy: 'coordinator:g1'
    }
    const receipt = db.transferMaestroWorkerTerminalLease(params)

    expect(db.getMaestroTerminalLease(predecessor.id)?.lifecycleState).toBe('superseded')
    expect(db.getMaestroTerminalLease(receipt.successorLeaseId)).toMatchObject({
      lifecycleState: 'active',
      workerTerminalResourceId: 'wtr_transfer'
    })
    expect(db.getWorkerTerminalResource('wtr_transfer')?.owner_dispatch_id).toBe('ctx_new')
    expect(db.retainMaestroTerminalLease(predecessor.id).lifecycleState).toBe('superseded')
    expect(() =>
      db!.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'release_pending' })
    ).toThrow(/cannot move from superseded/)
    expect(() =>
      db!.transferMaestroWorkerTerminalLease({
        ...params,
        requestId: 'transfer:competing',
        successorRequestId: 'worker:ctx_competing',
        successorDispatchId: 'ctx_competing',
        successorOwnerPrincipal: 'dispatch:ctx_competing'
      })
    ).toThrow(/identity is not authoritative/)
    expect(db.getWorkerTerminalResource('wtr_transfer')?.owner_dispatch_id).toBe('ctx_new')
    db.db
      .prepare("INSERT INTO worker_dispatches (dispatch_id, state) VALUES (?, 'failed')")
      .run('ctx_old')
    db.db
      .prepare("INSERT INTO worker_dispatches (dispatch_id, state) VALUES (?, 'failed')")
      .run('ctx_new')
    expect(
      db.settleDeadWorkerTerminalRelease({
        requestingDispatchId: 'ctx_old',
        resourceId: 'wtr_transfer',
        processIncarnation: 'pty:1'
      })
    ).toMatchObject({ disposition: 'retained' })
    expect(db.getWorkerTerminalResource('wtr_transfer')?.ownership_state).toBe('owned')
    expect(
      db.settleDeadWorkerTerminalRelease({
        requestingDispatchId: 'ctx_new',
        resourceId: 'wtr_transfer',
        processIncarnation: 'pty:1'
      })
    ).toMatchObject({ disposition: 'released' })
    expect(() =>
      db!.acceptMaestroTerminalInput({
        commandId: 'old-input',
        idempotencyKey: 'old-input',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        enqueueSequence: 1,
        sender: {
          principalId: 'worker:old',
          authority: 'worker',
          runId: 'run_1',
          coordinatorGeneration: null
        },
        leaseId: predecessor.id,
        executionHostId: 'local',
        workspaceKey: 'folder:one',
        terminalHandle: 'term_1',
        tabId: 'tab_1',
        ptyIncarnation: 'pty:1',
        expectedLifecycleState: 'superseded',
        observedInputSurface: 'working',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        expectedGraphRevision: null
      })
    ).toThrow(/Superseded terminal leases cannot accept input/)
    expect(db.getMaestroTerminalInputReceipt('old-input')).toBeUndefined()
    expect(db.transferMaestroWorkerTerminalLease(params)).toEqual(receipt)
    expect(
      db.transferMaestroWorkerTerminalLease({
        ...params,
        launchProfile: {
          permissionMode: launchProfile.permissionMode,
          routeRef: launchProfile.routeRef,
          effort: launchProfile.effort,
          model: launchProfile.model,
          agent: launchProfile.agent
        }
      })
    ).toEqual(receipt)
    expect(() =>
      db!.transferMaestroWorkerTerminalLease({ ...params, workspaceKey: 'worktree:other' })
    ).toThrow(/receipt identity differs/)
    expect(() =>
      db!.transferMaestroWorkerTerminalLease({
        ...params,
        launchProfile: { ...launchProfile, model: 'gpt-5.6-terra' }
      })
    ).toThrow(/receipt identity differs/)
    expect(() =>
      db!.transferMaestroWorkerTerminalLease({
        ...params,
        launchProfile: { ...launchProfile, effort: 'medium' }
      })
    ).toThrow(/receipt identity differs/)
    expect(() =>
      db!.transferMaestroWorkerTerminalLease({
        ...params,
        launchProfile: { ...launchProfile, permissionMode: 'default' }
      })
    ).toThrow(/receipt identity differs/)
    expect(db.getMaestroTerminalLease(receipt.successorLeaseId)?.workspaceKey).toBe('folder:one')
  })

  it('rejects non-exact transfer identity before changing lease authority', () => {
    const activeDb = new OrchestrationDb(':memory:')
    db = activeDb
    const run = activeDb.createRun({
      objective: 'transfer authority',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = activeDb.createTask({ runId: run.id, spec: 'retry exact worker' })
    const generation = activeDb.getRun(run.id)!.consumer_generation
    activeDb.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
          id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
          process_incarnation, ownership_state, release_state
        ) VALUES ('wtr_fenced', 'ctx_old', 'ctx_old', 'term_1', 'tab_1:leaf_1', 'pty:1', 'owned', 'not_requested')`
      )
      .run()
    const predecessor = activeDb.reserveMaestroTerminalLease({
      requestId: 'worker:fenced-old',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: run.id,
      taskId: task.id,
      attemptId: 'attempt_1',
      coordinatorGeneration: generation,
      role: 'worker',
      workerTerminalResourceId: 'wtr_fenced',
      title: 'fenced worker',
      launchProfile,
      spawnedBy: `coordinator:g${generation}`,
      ownerPrincipal: 'dispatch:ctx_old',
      retentionPolicy: 'auto_release'
    })
    activeDb.attachMaestroTerminalLease({
      leaseId: predecessor.id,
      terminalHandle: 'term_1',
      tabId: 'tab_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty:1',
      processRootId: 'pid:1'
    })
    activeDb.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'ready' })
    activeDb.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'active' })
    const params = {
      requestId: 'transfer:fenced',
      predecessorLeaseId: predecessor.id,
      successorRequestId: 'worker:fenced-new',
      kind: 'strict_retry' as const,
      successorDispatchId: 'ctx_new',
      runId: run.id,
      taskId: task.id,
      attemptId: 'attempt_1',
      terminalHandle: 'term_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty:1',
      processRootId: 'pid:1',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      hostScope: null,
      predecessorOwnerPrincipal: 'dispatch:ctx_old',
      successorOwnerPrincipal: 'dispatch:ctx_new',
      title: 'fenced worker',
      launchProfile,
      retentionPolicy: 'auto_release' as const,
      spawnedBy: `coordinator:g${generation}`
    }
    const validParams = { ...params, coordinatorGeneration: generation }
    const expectPredecessorAuthority = (receiptCount = 0): void => {
      expect(activeDb.getMaestroTerminalLease(predecessor.id)).toMatchObject({
        lifecycleState: 'active',
        workerTerminalResourceId: 'wtr_fenced'
      })
      expect(activeDb.getWorkerTerminalResource('wtr_fenced')).toMatchObject({
        owner_dispatch_id: 'ctx_old',
        ownership_state: 'owned',
        release_state: 'not_requested'
      })
      expect(
        activeDb.db
          .prepare('SELECT count(*) AS count FROM maestro_terminal_lease_transfer_receipts')
          .get()
      ).toEqual({ count: receiptCount })
    }
    const expectRejectedTransfer = (overrides: Partial<typeof validParams>): void => {
      expect(() =>
        activeDb.transferMaestroWorkerTerminalLease({ ...validParams, ...overrides })
      ).toThrow()
      expectPredecessorAuthority()
    }

    for (const coordinatorGeneration of [null, generation + 1]) {
      expect(() =>
        activeDb.transferMaestroWorkerTerminalLease({ ...params, coordinatorGeneration })
      ).toThrow(/fenced by the current Run generation/)
      expectPredecessorAuthority()
    }
    expectRejectedTransfer({ terminalHandle: 'term_other' })
    expectRejectedTransfer({ ptyIncarnation: 'pty:other' })
    expectRejectedTransfer({ processRootId: 'pid:reused' })
    expectRejectedTransfer({ executionHostId: 'ssh:other' })
    expectRejectedTransfer({ workspaceKey: 'folder:other' })
    expectRejectedTransfer({ predecessorOwnerPrincipal: 'dispatch:other' })
    expectRejectedTransfer({
      launchProfile: { ...launchProfile, permissionMode: 'default' }
    })
    activeDb.db
      .prepare(
        "UPDATE worker_terminal_resources SET ownership_state = 'external' WHERE id = 'wtr_fenced'"
      )
      .run()
    expect(() => activeDb.transferMaestroWorkerTerminalLease(validParams)).toThrow(
      /cleanup authority is no longer transferable/
    )
    activeDb.db
      .prepare(
        "UPDATE worker_terminal_resources SET ownership_state = 'owned' WHERE id = 'wtr_fenced'"
      )
      .run()
    activeDb.db
      .prepare(
        "UPDATE worker_terminal_resources SET release_state = 'released' WHERE id = 'wtr_fenced'"
      )
      .run()
    expect(() => activeDb.transferMaestroWorkerTerminalLease(validParams)).toThrow(
      /cleanup authority is no longer transferable/
    )
    activeDb.db
      .prepare(
        "UPDATE worker_terminal_resources SET release_state = 'not_requested' WHERE id = 'wtr_fenced'"
      )
      .run()
    expectPredecessorAuthority()
    activeDb.db
      .prepare(
        `INSERT INTO maestro_terminal_lease_transfer_receipts (request_id, receipt_json)
         VALUES (?, ?)`
      )
      .run(validParams.requestId, JSON.stringify({ version: 1, requestId: validParams.requestId }))
    expect(() => activeDb.transferMaestroWorkerTerminalLease(validParams)).toThrow(
      /receipt is incomplete/
    )
    expectPredecessorAuthority(1)
  })
})
