// Use the real host's fingerprint admission to reject envelopes derived from different fields.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { createQueuedMessageTestRig } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import type { QueuedMessageTestRig } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { openRigTurnFor } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-rig-turn.test-fixture'
import {
  sendAgentTurn,
  type AgentTurnDelivery,
  type StructuredAgentTurnHost
} from './send-agent-turn'

let rig: QueuedMessageTestRig

const MAIL_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: {
        address: 'term_peer',
        terminalHandle: 'term_peer',
        orcaSessionId: null
      },
      name: 'Claude'
    }
  ],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'dispatch:d1',
    dispatchId: 'd1',
    messages: [{ messageId: 'm1', runId: 'r1', from: 'term_peer' }]
  }
}

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function sendTurn(
  delivery: AgentTurnDelivery,
  operationId = hostTestOperationId(),
  host: StructuredAgentTurnHost = rig.host
) {
  return sendAgentTurn({
    kind: 'structured-session',
    host,
    sessionId: SESSION,
    callerKey: 'trusted-local:orchestration:d1',
    turn: {
      body: { ...hostTestMessage('mail'), from: MAIL_SOURCE },
      operationId,
      expectedRuntimeFence: 1,
      delivery
    }
  })
}

async function sentMessage(clientMessageId: string) {
  const snapshot = await rig.host.journalSnapshot(SESSION)
  return snapshot.items.find((item) => item.itemId === agentJournalSubmissionKey(clientMessageId))
}

describe('sendAgentTurn through the real host', () => {
  it('keeps the sender on the turn the queue sends', async () => {
    const working = await rig.workingSend()
    const operationId = hostTestOperationId()
    await sendTurn('queue', operationId)
    await rig.settleAccepted(working, 'work')
    await eventually(async () => expect(await rig.handoff(operationId)).toBeDefined())
    const item = await sentMessage(await rig.handoffId(operationId))
    expect(item?.body).toMatchObject({ from: MAIL_SOURCE })
  })

  it('replays a retried `queue` send instead of refusing it', async () => {
    await rig.workingSend()
    const operationId = hostTestOperationId()
    const first = await sendTurn('queue', operationId)
    await expect(sendTurn('queue', operationId)).resolves.toEqual(first)
    expect(await rig.drafts()).toHaveLength(1)
  })

  it('waits on the hand-off when a retried `queue` turn was already sent from the queue', async () => {
    const working = await rig.workingSend()
    const operationId = hostTestOperationId()
    await sendTurn('queue', operationId)
    await rig.settleAccepted(working, 'work')
    await eventually(async () => expect(await rig.handoff(operationId)).toBeDefined())
    const handoffId = await rig.handoffId(operationId)
    const waitedOn: string[] = []
    const host: StructuredAgentTurnHost = {
      send: rig.host.send.bind(rig.host),
      waitForSendSettlement: (sessionId, clientMessageId, options) => {
        waitedOn.push(clientMessageId)
        return rig.host.waitForSendSettlement(sessionId, clientMessageId, options)
      }
    }
    let returned = false
    const replay = sendTurn('queue', operationId, host).finally(() => {
      returned = true
    })
    await eventually(async () => expect(waitedOn).toHaveLength(1))
    await eventually(async () =>
      expect((await rig.submission(handoffId))?.handedOverAt).toBeDefined()
    )
    expect(returned).toBe(false)
    await rig.settleAccepted(handoffId, 'mail')
    await expect(replay).resolves.toMatchObject({
      kind: 'sent',
      submission: { clientMessageId: handoffId, dispatchState: 'accepted' }
    })
    expect(waitedOn).toEqual([handoffId])
  })

  /** Settles a handed-over send as the provider taking it; the turn's wait ends on that. */
  async function sendTurnAccepted(
    delivery: AgentTurnDelivery,
    operationId = hostTestOperationId()
  ) {
    const outcome = sendTurn(delivery, operationId)
    let handedOverId = operationId
    await eventually(async () => {
      const submission = (await rig.handoff(operationId)) ?? (await rig.submission(operationId))
      expect(submission?.handedOverAt).toBeDefined()
      handedOverId = submission!.clientMessageId
    })
    await rig.settleAccepted(handedOverId, 'mail')
    return outcome
  }

  it.each(['now', 'queue'] as const)('sends a `%s` turn to an idle agent', async (delivery) => {
    const outcome = await sendTurnAccepted(delivery)
    expect(outcome).toMatchObject({ kind: 'sent', submission: { dispatchState: 'accepted' } })
    expect(await rig.drafts()).toEqual([])
    const sent = outcome.kind === 'sent' ? outcome.clientMessageId : ''
    expect((await sentMessage(sent))?.body).toMatchObject({ from: MAIL_SOURCE })
  })

  it('has a `now` send join the running turn through its row', async () => {
    const working = await rig.workingSend()
    await rig.settleAccepted(working, 'work')
    await openRigTurnFor(rig, working)
    await expect(sendTurnAccepted('now')).resolves.toMatchObject({ kind: 'queued' })
    expect(await rig.drafts()).toEqual([])
  })
})
