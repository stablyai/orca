import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/protocol-version'
import type { WorkerTerminalOwnershipState } from '../../worker-terminal-ownership'

const PANE_KEY = 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

// The federated guard used to be a hand-copied ladder; both entry points now read the one table.
describe('the remote attachment release guard', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function settledAttachment(dispatchId: string): void {
    db.createRemoteDispatchAttachment({
      dispatchId,
      taskId: `task_${dispatchId}`,
      homePeerFingerprint: 'home-peer',
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: 'epoch-1',
      mutationReceipt: {
        callerFingerprint: 'home-peer',
        requestId: `request_${dispatchId}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `hash_${dispatchId}`
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:7',
      worktreeId: 'repo::remote',
      terminalHandle: `term_${dispatchId}`,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: `term_${dispatchId}` }],
      terminalOwnership: 'created'
    })
    db.markRemoteAttachmentReady(dispatchId)
    db.recordRemoteAttachmentStage({ dispatchId, state: 'succeeded', stage: 'worker_reported' })
  }

  it.each([
    ['owned', 'requested', undefined],
    ['transferred', 'retained', 'ownership_transferred'],
    ['user_owned', 'retained', 'user_takeover'],
    ['external', 'retained', 'external_terminal'],
    ['released', 'already_released', undefined]
  ] as [WorkerTerminalOwnershipState, string, string | undefined][])(
    'maps %s ownership to %s, the same verdict the local guard reaches',
    (ownership, disposition, reason) => {
      const dispatchId = `ctx_${ownership}`
      settledAttachment(dispatchId)
      const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
      db.db
        .prepare('UPDATE worker_terminal_resources SET ownership_state = ? WHERE id = ?')
        .run(ownership, resource.id)

      const result = db.requestRemoteAttachmentTerminalRelease(dispatchId)
      expect(result.disposition).toBe(disposition)
      if (reason) {
        expect(result).toMatchObject({ reason })
      }
    }
  )
})
