import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('Run-home message routing', () => {
  const home = createOrchestrationRpcHarness()
  const worker = createOrchestrationRpcHarness()
  afterEach(() => {
    home.cleanup()
    worker.cleanup()
  })

  function setupPair() {
    const authority = home.setup()
    const shadow = worker.setup(false)
    const runId = authority.activeRunId!
    shadow.db.createRemoteDispatchAttachment({
      runId,
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: shadow.runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'attach',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach'
      }
    })
    return { authority, shadow, runId }
  }

  it('rejects an unbound sender into the same-ID remote shadow before persistence', async () => {
    const { authority, shadow, runId } = setupPair()
    const notify = vi.spyOn(shadow.runtime, 'notifyMessageArrived')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        worker.call(
          'orchestration.send',
          {
            from: 'term_unbound',
            to: `run:${runId}`,
            subject: 'status'
          },
          shadow.ctx
        )
      ).rejects.toMatchObject({
        code: 'run_destination_unsupported',
        data: {
          effectsApplied: false,
          routing: { runId, home: 'remote', homePeerFingerprints: ['home_peer'] }
        }
      })
    }
    expect(shadow.db.getInbox(100)).toEqual([])
    expect(authority.db.getInbox(100)).toEqual([])
    expect(shadow.db.listPendingFederationRelay('ctx_remote', 'to_home')).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    expect(authority.db.getRun(runId)?.consumer_generation).toBe(1)
    expect(shadow.db.getRun(runId)?.consumer_generation).toBe(0)
  })

  it('does not trust a stale local binding on a remote shadow', async () => {
    const { shadow, runId } = setupPair()
    shadow.db.db
      .prepare(`UPDATE runs SET coordinator_handle = 'stale',
      coordinator_pane_key = 'old:leaf', consumer_generation = 8 WHERE id = ?`)
      .run(runId)
    await expect(
      worker.call(
        'orchestration.send',
        {
          from: 'term_unbound',
          to: `run:${runId}`,
          subject: 'status'
        },
        shadow.ctx
      )
    ).rejects.toMatchObject({ code: 'run_destination_unsupported' })
    expect(shadow.db.getInbox(100)).toEqual([])
  })

  it('rejects a never-bound local record without inventing a Run owner', async () => {
    const { db, ctx } = worker.setup(false)
    db.db.prepare(`INSERT INTO runs (id, objective) VALUES ('run_orphan', 'orphan')`).run()
    await expect(
      worker.call(
        'orchestration.send',
        {
          from: 'term_unbound',
          to: 'run:run_orphan',
          subject: 'status'
        },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'run_destination_unresolved',
      data: { effectsApplied: false }
    })
    expect(db.getInbox(100)).toEqual([])
  })

  it('fails closed on an unknown home marker even with a past local binding', async () => {
    const { db, ctx, activeRunId } = home.setup()
    db.db.prepare("UPDATE runs SET home_database = 'future_home' WHERE id = ?").run(activeRunId!)
    await expect(
      home.call(
        'orchestration.send',
        {
          from: 'term_unbound',
          to: `run:${activeRunId}`,
          subject: 'status'
        },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'run_destination_unresolved',
      data: { effectsApplied: false, routing: { home: 'unresolved' } }
    })
    expect(db.getInbox(100)).toEqual([])
  })

  it('keeps authoritative local mail queued while the coordinator is offline', async () => {
    const { db, runtime, ctx, activeRunId } = home.setup()
    vi.mocked(runtime.getTerminalPaneKey).mockReturnValue(null)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const result = await home.call(
      'orchestration.send',
      {
        from: 'term_unbound',
        to: `run:${activeRunId}`,
        subject: 'status'
      },
      ctx
    )
    expect(result).toMatchObject({
      delivery: { state: 'queued', destination: 'run_home', runId: activeRunId },
      message: { to_handle: `run:${activeRunId}` }
    })
    expect(db.getUnreadRunMailbox(activeRunId!)).toHaveLength(1)
  })

  it('preserves a historical local Run queue after the coordinator switches Runs', async () => {
    const { db, runtime, ctx, activeRunId } = home.setup()
    db.createRun({
      objective: 'next',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: home.coordinatorPaneKey
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    await expect(
      home.call(
        'orchestration.send',
        {
          from: 'term_unbound',
          to: `run:${activeRunId}`,
          subject: 'late status'
        },
        ctx
      )
    ).resolves.toMatchObject({ delivery: { state: 'queued' } })
    expect(db.getUnreadRunMailbox(activeRunId!)).toHaveLength(1)
  })

  it('exposes persisted home and binding evidence without taking over the Run', async () => {
    const { shadow, runId } = setupPair()
    await expect(
      worker.call('orchestration.runShow', { id: runId }, shadow.ctx)
    ).resolves.toMatchObject({
      routing: {
        runId,
        runtimeId: shadow.runtime.getRuntimeId(),
        home: 'remote',
        homePeerFingerprints: ['home_peer'],
        coordinatorHandle: null,
        consumerGeneration: 0
      }
    })
    expect(shadow.db.getRun(runId)?.consumer_generation).toBe(0)
  })
})
