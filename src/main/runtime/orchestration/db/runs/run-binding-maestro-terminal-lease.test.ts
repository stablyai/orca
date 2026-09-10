import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const profile = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol',
  effort: 'high',
  permissionMode: 'yolo',
  routeRef: 'route:coordinator'
}

describe('Run binding Maestro terminal lease transaction', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('fences and retains the predecessor before publishing successor authority', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'coordinate',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: 'tab_old:leaf_old'
    })
    const predecessor = db.reserveMaestroTerminalLease({
      requestId: 'old:g1',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: run.id,
      coordinatorGeneration: run.consumer_generation,
      role: 'coordinator',
      coordinatorRunId: run.id,
      title: 'Harness · coordinator g1 · Codex',
      launchProfile: profile,
      spawnedBy: 'bootstrap',
      ownerPrincipal: 'coordinator:g1',
      retentionPolicy: 'auto_release'
    })
    db.attachMaestroTerminalLease({
      leaseId: predecessor.id,
      terminalHandle: 'term_old',
      tabId: 'tab_old',
      paneKey: 'tab_old:leaf_old',
      ptyIncarnation: 'pty_old:1',
      processRootId: 'pty_old'
    })
    db.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'ready' })
    db.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'active' })
    db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'survives handoff'
    })
    const delivery = db.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })!
    let handoff = db.reserveCoordinatorHandoff({
      requestId: 'handoff:1',
      runId: run.id,
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      title: 'Harness · coordinator g2 · Codex',
      launchProfile: profile,
      spawnedBy: 'coordinator:g1',
      ownerPrincipal: 'coordinator:g2',
      capsuleDigest: `sha256:${'a'.repeat(64)}`,
      inputIdempotencyKey: 'handoff:1:input',
      expectedGraphRevision: 12,
      retentionPolicy: 'auto_release'
    })
    expect(db.getRun(run.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      consumer_generation: handoff.claimedGeneration
    })
    expect(db.getMaestroTerminalLease(predecessor.id)?.lifecycleState).toBe('retained')
    expect(db.getDeliveryRaw(delivery.delivery.id)?.consumer_generation).toBe(
      handoff.claimedGeneration
    )
    db.attachMaestroTerminalLease({
      leaseId: handoff.successorLeaseId,
      terminalHandle: 'term_new',
      tabId: 'tab_new',
      paneKey: 'tab_new:leaf_new',
      ptyIncarnation: 'pty_new:1',
      processRootId: 'pty_new'
    })
    db.transitionMaestroTerminalLease({ leaseId: handoff.successorLeaseId, state: 'ready' })
    handoff = db.advanceCoordinatorHandoff({
      requestId: handoff.requestId,
      phase: 'spawned',
      terminalHandle: 'term_new',
      tabId: 'tab_new',
      ptyIncarnation: 'pty_new:1'
    })
    const { receipt: input } = db.acceptMaestroTerminalInput({
      commandId: 'command:1',
      idempotencyKey: handoff.inputIdempotencyKey,
      contentDigest: handoff.capsuleDigest,
      enqueueSequence: 1,
      sender: {
        principalId: 'coordinator:g1',
        authority: 'coordinator',
        runId: run.id,
        coordinatorGeneration: handoff.claimedGeneration
      },
      leaseId: handoff.successorLeaseId,
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      terminalHandle: 'term_new',
      tabId: 'tab_new',
      ptyIncarnation: 'pty_new:1',
      expectedLifecycleState: 'ready',
      observedInputSurface: 'ready_prompt',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedGraphRevision: 12
    })
    db.transitionMaestroTerminalInput({
      commandId: input.commandId,
      state: 'written_to_pty',
      bytesWritten: 10,
      enterWritten: true
    })
    db.transitionMaestroTerminalInput({
      commandId: input.commandId,
      state: 'acknowledged',
      acknowledgedGraphRevision: 12
    })
    db.advanceCoordinatorHandoff({
      requestId: handoff.requestId,
      phase: 'capsule_delivery_acknowledged'
    })
    db.advanceCoordinatorHandoff({
      requestId: handoff.requestId,
      phase: 'coordinator_claimed',
      observedGraphRevision: 12
    })

    const committed = db.commitCoordinatorHandoffAuthority({
      requestId: handoff.requestId,
      coordinatorPaneKey: 'tab_new:leaf_new'
    })

    expect(committed.phase).toBe('authority_committed')
    expect(db.getRun(run.id)).toMatchObject({
      coordinator_handle: 'term_new',
      coordinator_pane_key: 'tab_new:leaf_new',
      consumer_generation: run.consumer_generation + 1
    })
    expect(db.getMaestroTerminalLease(predecessor.id)?.lifecycleState).toBe('retained')
    expect(db.getMaestroTerminalLease(handoff.successorLeaseId)?.lifecycleState).toBe('active')
    expect(
      db.acknowledgeRunDelivery({
        runId: run.id,
        consumerGeneration: handoff.claimedGeneration,
        deliveryId: delivery.delivery.id
      }).delivery.status
    ).toBe('acknowledged')
  })

  it('preserves a surviving pane generation and advances a new successor', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'rebind coordinator',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: 'tab_old:11111111-1111-4111-8111-111111111111'
    })

    expect(
      db.bindRun({
        runId: run.id,
        coordinatorHandle: 'term_reminted',
        coordinatorPaneKey: 'tab_reminted:11111111-1111-4111-8111-111111111111'
      })
    ).toMatchObject({ coordinator_handle: 'term_reminted', consumer_generation: 1 })
    expect(
      db.bindRun({
        runId: run.id,
        coordinatorHandle: 'term_successor',
        coordinatorPaneKey: 'tab_new:22222222-2222-4222-9222-222222222222'
      })
    ).toMatchObject({ coordinator_handle: 'term_successor', consumer_generation: 2 })
  })
})
