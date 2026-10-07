// sendAgentTurn against the real host, store and journal, so the envelope it builds has to pass the
// host's own admission: a fingerprint over other fields than the send carries is refused there.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from '../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { openRigTurnFor } from '../../native-chat/agent-session-wire/structured-agent-session-queued-rig-turn.test-fixture'
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

/** The transcript item a send became. */
async function sentMessage(clientMessageId: string) {
  const snapshot = await rig.host.journalSnapshot(SESSION)
  return snapshot.items.find((item) => item.itemId === agentJournalSubmissionKey(clientMessageId))
}

describe('sendAgentTurn through the real host', () => {
  it('has a `queue` send held as a draft while the agent works', async () => {
    await rig.workingSend()
    await expect(sendTurn('queue')).resolves.toMatchObject({
      kind: 'queued',
      queued: { position: 1, state: 'waiting' }
    })
    // On the card's body, read back whole and published with it.
    expect(
      rig.host
        .collaboratorsForTests()
        .sessions.get(SESSION)
        ?.journal.queuedMessages.list()
        .map(({ state, body }) => ({ state, from: body.from }))
    ).toEqual([{ state: 'waiting', from: MAIL_SOURCE }])
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.map(({ body }) => body.from)).toEqual([MAIL_SOURCE])
  })

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
    await eventually(async () =>
      expect((await rig.submission(operationId))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(operationId, 'mail')
    return outcome
  }

  it.each(['now', 'queue'] as const)('sends a `%s` turn to an idle agent', async (delivery) => {
    const outcome = await sendTurnAccepted(delivery)
    expect(outcome).toMatchObject({ kind: 'sent', submission: { dispatchState: 'accepted' } })
    expect(await rig.drafts()).toEqual([])
    // An idle chat never queues, and the sent message still names its sender.
    const sent = outcome.kind === 'sent' ? outcome.clientMessageId : ''
    expect((await sentMessage(sent))?.body).toMatchObject({ from: MAIL_SOURCE })
  })

  // An idle chat sends the mail at once: its submission says it is an agent's, without the senders
  // the card keeps host-only, so a restart or a close rejects it rather than keep it as a card.
  it('records an idle chat’s mail as an agent’s, by kind only', async () => {
    const operationId = hostTestOperationId()
    await sendTurnAccepted('queue', operationId)
    const submission = await rig.submission(operationId)
    expect(submission?.source).toEqual({ kind: 'agent' })
    expect(JSON.stringify(submission)).not.toContain('term_peer')
  })

  it('has a `now` send join the running turn, never the queue', async () => {
    await openRigTurnFor(rig, await rig.workingSend())
    await expect(sendTurnAccepted('now')).resolves.toMatchObject({
      kind: 'sent',
      submission: { dispatchState: 'accepted' }
    })
    expect(await rig.drafts()).toEqual([])
  })
})
