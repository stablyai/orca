import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

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

  it('keeps legacy acknowledgments optional after local completion', () => {
    const legacy = createReadyAttachment(2)
    const report = enqueueCompletion(legacy.db, legacy.dispatchId, 'succeeded')

    expect(() =>
      legacy.db.acknowledgeFederationRelay({
        dispatchId: legacy.dispatchId,
        direction: 'to_home',
        throughSequence: report.sequence
      })
    ).not.toThrow()
    expect(legacy.db.getRemoteDispatchAttachment(legacy.dispatchId)?.state).toBe('succeeded')
    expect(legacy.db.listPendingFederationRelay(legacy.dispatchId, 'to_home')).toHaveLength(0)
  })

  it('acknowledges a protocol-v3 rejected report without settling the attachment', () => {
    const current = createReadyAttachment(3)
    const report = enqueueCompletion(current.db, current.dispatchId)

    current.db.acknowledgeFederationRelay({
      dispatchId: current.dispatchId,
      direction: 'to_home',
      throughSequence: report.sequence,
      settleRemoteReports: [{ sequence: report.sequence }]
    })

    expect(current.db.getRemoteDispatchAttachment(current.dispatchId)?.state).toBe('ready')
    expect(current.db.listPendingFederationRelay(current.dispatchId, 'to_home')).toHaveLength(0)
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

  it('accepts an identical answer that wins between classification and the guarded update', () => {
    const current = createReadyAttachment(3)
    enqueueQuestion(current.db, current.dispatchId, 'question_race')
    const sqlite = (current.db as unknown as { db: Database.Database }).db
    const originalPrepare = sqlite.prepare.bind(sqlite)
    let injected = false
    const prepare = vi.spyOn(sqlite, 'prepare').mockImplementation((sql) => {
      const statement = originalPrepare(sql)
      if (!injected && sql.includes('UPDATE remote_questions')) {
        injected = true
        statement.run('answer_race', 'Yes', 'question_race')
      }
      return statement
    })

    expect(() =>
      current.db.answerRemoteQuestion({
        messageId: 'question_race',
        dispatchId: current.dispatchId,
        answerMessageId: 'answer_race',
        body: 'Yes'
      })
    ).not.toThrow()
    expect(injected).toBe(true)
    expect(current.db.getRemoteQuestion('question_race')).toMatchObject({
      status: 'answered',
      answer_message_id: 'answer_race',
      answer_body: 'Yes'
    })
    prepare.mockRestore()
  })
})
