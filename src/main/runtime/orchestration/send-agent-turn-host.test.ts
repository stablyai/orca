// sendAgentTurn against the real host, store and journal, so the envelope it builds has to pass the
// host's own admission: a fingerprint over other fields than the send carries is refused there.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
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
      }
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
      body: hostTestMessage('mail'),
      operationId,
      expectedRuntimeFence: 1,
      ...(delivery === 'queue' ? { delivery, source: MAIL_SOURCE } : { delivery })
    }
  })
}

describe('sendAgentTurn through the real host', () => {
  it('has a `queue` send held as a draft while the agent works', async () => {
    await rig.workingSend()
    await expect(sendTurn('queue')).resolves.toMatchObject({
      kind: 'queued',
      queued: { position: 1, state: 'waiting' }
    })
    // Stored with the card, read back whole: who it is from survives the round trip.
    expect(
      rig.host
        .collaboratorsForTests()
        .sessions.get(SESSION)
        ?.journal.queuedMessages.list()
        .map(({ state, source }) => ({ state, source }))
    ).toEqual([{ state: 'waiting', source: MAIL_SOURCE }])
    // Shown in the chat's queue like the person's own card.
    expect(await rig.drafts()).toMatchObject([{ state: 'waiting' }])
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
  async function sendTurnAccepted(delivery: AgentTurnDelivery) {
    const operationId = hostTestOperationId()
    const outcome = sendTurn(delivery, operationId)
    await eventually(async () =>
      expect((await rig.submission(operationId))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(operationId, 'mail')
    return outcome
  }

  it.each(['now', 'queue'] as const)('sends a `%s` turn to an idle agent', async (delivery) => {
    await expect(sendTurnAccepted(delivery)).resolves.toMatchObject({
      kind: 'sent',
      submission: { dispatchState: 'accepted' }
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('has a `now` send join the running turn, never the queue', async () => {
    await rig.workingSend()
    await expect(sendTurnAccepted('now')).resolves.toMatchObject({
      kind: 'sent',
      submission: { dispatchState: 'accepted' }
    })
    expect(await rig.drafts()).toEqual([])
  })
})
