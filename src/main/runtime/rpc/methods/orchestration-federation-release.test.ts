import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { reconcileRequestedWorkerTerminalReleases } from '../../orchestration/worker-terminal-release-reconciliation'
import { releaseRemoteAttachment } from './orchestration-federation-release'

describe('remote attachment terminal release', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function setupSettledAttachment() {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote_release',
      taskId: 'task_remote_release',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 2,
      runtimeEpoch: 'worker_epoch',
      deadlineAt: '2099-01-01T00:00:00.000Z',
      maxRequests: 10,
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'remote_release_start',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_release_payload'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: 'ctx_remote_release',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'worker_epoch:pty:1',
      worktreeId: 'repo::worktree',
      terminalHandle: 'term_remote_worker',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_remote_worker' }]
    })
    db.markRemoteAttachmentReady('ctx_remote_release')
    db.enqueueFederationRelay({
      dispatchId: 'ctx_remote_release',
      direction: 'to_home',
      kind: 'message',
      payload: '{}',
      settleRemoteOutcome: 'succeeded'
    })
    return db.getRemoteDispatchAttachment('ctx_remote_release')!
  }

  it('marks authoritative remote terminal absence unknown instead of retrying forever', async () => {
    const attachment = setupSettledAttachment()
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db as OrchestrationDb)
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('terminal_handle_stale'))

    await expect(
      releaseRemoteAttachment({ runtime, db: db as OrchestrationDb, attachment })
    ).resolves.toMatchObject({
      state: 'release_unknown',
      processAction: 'none'
    })
    expect(db?.getWorkerTerminalResourceByOwner(attachment.dispatch_id)).toMatchObject({
      release_state: 'unknown'
    })

    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 1,
      pending: 0,
      unknown: 0,
      retained: 1
    })
    expect(db?.getWorkerTerminalResourceByOwner(attachment.dispatch_id)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'identity_unproven'
    })
    expect(db?.listWorkerTerminalReleaseBacklog()).toEqual([])
  })
})
