import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { failFederatedAttachmentWithReceipt } from './orchestration-federation-start-receipt'

describe('federated worker start receipt', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  it('persists ambiguous prompt delivery as start_unknown', () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    db.createRemoteDispatchAttachment({
      dispatchId: 'dispatch-unknown',
      taskId: 'task-unknown',
      homePeerFingerprint: 'home-peer',
      protocolVersion: 3,
      runtimeEpoch: 'runtime-1',
      mutationReceipt: {
        callerFingerprint: 'home-peer',
        requestId: 'request-unknown',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload-unknown'
      }
    })
    const error = Object.assign(new Error('Agent prompt delivery outcome is unknown'), {
      code: 'operation_unknown'
    })

    const receipt = failFederatedAttachmentWithReceipt({
      db,
      dispatchId: 'dispatch-unknown',
      runtimeEpoch: 'runtime-1',
      failedStage: 'dispatch_input',
      error,
      setup: {
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: true,
        startupPolicy: 'start-immediately',
        state: 'running'
      },
      launch: {
        requested: { agent: 'codex', model: null, effort: null },
        effective: { agent: 'codex', model: null, effort: null }
      }
    })

    expect(receipt).toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'dispatch_input'
    })
    expect(db.getRemoteDispatchAttachment('dispatch-unknown')?.state).toBe('start_unknown')
  })
})
