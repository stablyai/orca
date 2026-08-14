import { afterEach, describe, expect, it } from 'vitest'
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
})
