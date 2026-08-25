import { describe, expect, it } from 'vitest'
import {
  verifyCrossPlaneAck,
  type CrossPlaneAckEvidence
} from '../../../shared/orchestration-ack-contract'
import { createOrchestrationRpcHarness } from '../rpc/methods/orchestration-rpc-test-harness'

function evidence(overrides: Partial<CrossPlaneAckEvidence> = {}): CrossPlaneAckEvidence {
  return {
    messageId: 'msg_1',
    sequence: 10,
    threadId: 'thread_1',
    correlationId: 'corr_1',
    senderEpoch: 'orca:7',
    receiverEpoch: 'herdr:12',
    ackMessageId: 'msg_ack_1',
    ackSequence: 11,
    ackReadBack: true,
    ackCorrelationId: 'corr_1',
    ackSenderEpoch: 'herdr:12',
    ackReceiverEpoch: 'orca:7',
    completionReceiptId: 'completion_1',
    nativeCompletionQueryBack: true,
    nativeCompletionCorrelationId: 'corr_1',
    identityLink: {
      orcaIdentity: 'dispatch:ctx_1',
      externalPlane: 'herdr',
      externalIdentity: 'pane:42',
      linkedBy: 'neutral_coordinator',
      evidenceId: 'link_1'
    },
    ...overrides
  }
}

describe('cross-plane ACK contract', () => {
  it('keeps storage acceptance distinct from delivery without query-backed ACK', () => {
    expect(
      verifyCrossPlaneAck(
        evidence({
          ackMessageId: undefined,
          ackSequence: undefined,
          ackReadBack: false,
          completionReceiptId: undefined,
          nativeCompletionQueryBack: false
        })
      )
    ).toMatchObject({
      state: 'accepted',
      verified: false,
      effectsApplied: false,
      missing: expect.arrayContaining(['receiverAckQueryBack'])
    })
  })

  it('marks prompt delivered only after correlation echo and ACK query-back', () => {
    expect(
      verifyCrossPlaneAck(
        evidence({ completionReceiptId: undefined, nativeCompletionQueryBack: false })
      )
    ).toEqual({
      state: 'prompt_delivered',
      verified: false,
      effectsApplied: false,
      missing: ['nativeCompletionQueryBack']
    })
  })

  it('requires both result receipt and native runtime query-back for completion', () => {
    expect(verifyCrossPlaneAck(evidence())).toEqual({
      state: 'completion_verified',
      verified: true,
      effectsApplied: false,
      missing: []
    })
  })

  it.each([
    ['correlation mismatch', { ackCorrelationId: 'corr_other' }],
    ['sender epoch mismatch', { ackReceiverEpoch: 'orca:8' }],
    ['receiver epoch mismatch', { ackSenderEpoch: 'herdr:13' }],
    ['fabricated sequence', { ackSequence: 9 }],
    ['missing read-back', { ackReadBack: false }]
  ])('fails closed for %s', (_name, override) => {
    expect(verifyCrossPlaneAck(evidence(override))).toMatchObject({
      state: 'accepted',
      verified: false,
      effectsApplied: false,
      missing: expect.arrayContaining(['receiverAckQueryBack'])
    })
  })

  it('rejects identity conflation without neutral coordinator evidence', () => {
    expect(
      verifyCrossPlaneAck(
        evidence({
          identityLink: {
            orcaIdentity: 'same',
            externalPlane: 'herdr',
            externalIdentity: 'same',
            linkedBy: 'neutral_coordinator',
            evidenceId: 'link_1'
          }
        })
      )
    ).toMatchObject({
      verified: false,
      effectsApplied: false,
      missing: expect.arrayContaining(['identityLink.distinctIdentities'])
    })
  })

  it('rejects an empty external control-plane identity', () => {
    expect(
      verifyCrossPlaneAck(
        evidence({
          identityLink: {
            orcaIdentity: 'dispatch:ctx_1',
            externalPlane: '   ',
            externalIdentity: 'pane:42',
            linkedBy: 'neutral_coordinator',
            evidenceId: 'link_1'
          }
        })
      )
    ).toMatchObject({
      verified: false,
      effectsApplied: false,
      missing: expect.arrayContaining(['identityLink.externalPlane'])
    })
  })
})

describe('cross-plane ACK runtime query-back', () => {
  const harness = createOrchestrationRpcHarness()

  it('derives completion verification from stored messages and native Dispatch state', async () => {
    const { db, ctx } = harness.setup()
    try {
      const task = db.createTask({ spec: 'verify result' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
      const original = db.insertMessage({
        from: 'dispatch:sender',
        to: 'external:receiver',
        subject: 'prompt',
        threadId: 'thread_1',
        payload: JSON.stringify({ correlationId: 'corr_1', senderEpoch: 'orca:7' })
      })
      const ack = db.insertMessage({
        from: 'external:receiver',
        to: 'dispatch:sender',
        subject: 'ack',
        threadId: 'thread_1',
        payload: JSON.stringify({
          correlationId: 'corr_1',
          senderEpoch: 'herdr:12',
          receiverEpoch: 'orca:7'
        })
      })
      const completion = db.insertMessage({
        from: 'external:receiver',
        to: 'dispatch:sender',
        subject: 'completion',
        threadId: 'thread_1',
        payload: JSON.stringify({ correlationId: 'corr_1' })
      })
      db.completeDispatch(dispatch.id)

      await expect(
        harness.call(
          'orchestration.crossPlaneVerify',
          {
            messageId: original.id,
            ackMessageId: ack.id,
            completionReceiptId: completion.id,
            correlationId: 'corr_1',
            senderEpoch: 'orca:7',
            receiverEpoch: 'herdr:12',
            dispatchId: dispatch.id,
            orcaIdentity: 'dispatch:sender',
            externalPlane: 'herdr',
            externalIdentity: 'pane:42',
            linkEvidenceId: 'link_1'
          },
          ctx
        )
      ).resolves.toEqual({
        state: 'completion_verified',
        verified: true,
        effectsApplied: false,
        missing: []
      })
    } finally {
      harness.cleanup()
    }
  })

  it('does not trust caller claims when ACK and completion rows are absent', async () => {
    const { db, ctx } = harness.setup()
    try {
      const original = db.insertMessage({
        from: 'dispatch:sender',
        to: 'external:receiver',
        subject: 'prompt'
      })
      await expect(
        harness.call(
          'orchestration.crossPlaneVerify',
          {
            messageId: original.id,
            ackMessageId: 'fabricated_ack',
            completionReceiptId: 'fabricated_completion',
            correlationId: 'corr_1',
            senderEpoch: 'orca:7',
            receiverEpoch: 'herdr:12',
            dispatchId: 'ctx_missing',
            orcaIdentity: 'dispatch:sender',
            externalPlane: 'herdr',
            externalIdentity: 'pane:42',
            linkEvidenceId: 'link_1'
          },
          ctx
        )
      ).resolves.toMatchObject({
        state: 'accepted',
        verified: false,
        effectsApplied: false,
        missing: expect.arrayContaining(['receiverAckQueryBack', 'nativeCompletionQueryBack'])
      })
    } finally {
      harness.cleanup()
    }
  })
})
