import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

describe('creatorStartsChatWorkers', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => db.close())

  it('inherits a paired bot worker lineage for its local helper', () => {
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      runId: 'run_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 1,
      runtimeEpoch: 'epoch',
      chatLineage: true,
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'attach',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: 'ctx_remote',
      paneKey: 'pane:worker',
      processIncarnation: 'worker:1',
      worktreeId: 'worktree',
      terminalHandle: 'term_worker',
      setupState: 'not_applicable',
      effects: []
    })

    expect(
      db.creatorStartsChatWorkers({
        kind: 'terminal',
        handle: 'term_worker',
        paneKey: 'pane:worker',
        processIncarnation: 'worker:1'
      })
    ).toBe(true)
  })
})
