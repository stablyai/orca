import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

describe('federation acknowledgment integrity', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createReadyAttachment(protocolVersion: number): {
    db: OrchestrationDb
    dispatchId: string
  } {
    db = new OrchestrationDb(':memory:')
    const dispatchId = `ctx_protocol_${protocolVersion}`
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId,
      taskId: `task_protocol_${protocolVersion}`,
      homePeerFingerprint: 'home_peer',
      protocolVersion,
      runtimeEpoch: 'worker_epoch',
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: `attach_protocol_${protocolVersion}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `attach_hash_${protocolVersion}`
      }
    })
    db.recordRemoteAttachmentStage({
      dispatchId,
      stage: 'input_accepted',
      state: 'ready'
    })
    return { db, dispatchId }
  }

  function enqueueCompletion(
    target: OrchestrationDb,
    dispatchId: string,
    settleRemoteOutcome?: 'succeeded'
  ) {
    return target.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'worker_done',
      payload: JSON.stringify({
        payload: JSON.stringify({
          taskId: dispatchId.replace('ctx_', 'task_'),
          dispatchId,
          outcome: 'succeeded'
        })
      }),
      ...(settleRemoteOutcome ? { settleRemoteOutcome } : {})
    })
  }

  function enqueueQuestion(target: OrchestrationDb, dispatchId: string, messageId: string): void {
    target.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'question',
      payload: '{}',
      messageId,
      remoteQuestion: true
    })
  }

  it('rejects a protocol-v3 acknowledgment without a lifecycle verdict atomically', () => {
    const current = createReadyAttachment(3)
    const report = enqueueCompletion(current.db, current.dispatchId)

    expect(() =>
      current.db.acknowledgeFederationRelay({
        dispatchId: current.dispatchId,
        direction: 'to_home',
        throughSequence: report.sequence
      })
    ).toThrowError(expect.objectContaining({ code: 'request_mismatch' }))
    expect(current.db.getRemoteDispatchAttachment(current.dispatchId)?.state).toBe('ready')
    expect(current.db.listPendingFederationRelay(current.dispatchId, 'to_home')).toHaveLength(1)
  })

  it('accepts an identical remote answer replay and rejects a conflicting replay', () => {
    const current = createReadyAttachment(3)
    enqueueQuestion(current.db, current.dispatchId, 'question_replay')
    const answer = {
      messageId: 'question_replay',
      dispatchId: current.dispatchId,
      answerMessageId: 'answer_1',
      body: 'Yes'
    }

    current.db.answerRemoteQuestion(answer)

    expect(() => current.db.answerRemoteQuestion(answer)).not.toThrow()
    expect(() => current.db.answerRemoteQuestion({ ...answer, body: 'No' })).toThrowError(
      expect.objectContaining({ code: 'answer_conflict' })
    )
  })
})
