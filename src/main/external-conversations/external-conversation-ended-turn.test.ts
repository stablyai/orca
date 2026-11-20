import { afterEach, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ConversationChat } from './external-conversation-chat'
import { endedTurn } from './external-conversation-ended-turn'
import { chatTurnFor } from './external-conversation-turn-state'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import {
  turnRowsChat,
  turnRowsTarget,
  turnRowsUser as user
} from '../native-chat/agent-session-journal/journal-domain-turn-rows.test-fixture'

// Design item 125 §3 (turn membership): an ended turn's deliveries are its opener's and each send the
// provider proved it steered in, keyed by the turn row's journal key rather than the provider's
// turn id. A message whose turn scope only the host set at handover is not evidence. Its prose is
// the turn's own.

const TURN_KEY = 'item:turn-1'
const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }

const item = (
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  turnItemId?: string
): AgentJournalRenderItem => ({
  itemId,
  revision: 1,
  body,
  sequence,
  observedAt: sequence,
  ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
})
const asked = (deliveryId: string, sequence: number, turnItemId?: string) =>
  item(
    agentJournalSubmissionKey(deliveryId),
    sequence,
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: deliveryId }],
      connectorDelivery: { account: 'account-a', conversation: SLACK, deliveryId }
    },
    turnItemId
  )
const steered: AgentJournalSubmission = {
  clientMessageId: 'd1',
  fence: 1,
  payloadFingerprint: 'd1',
  dispatchState: 'accepted',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: 2,
  answeredInTurn: { turnItemId: TURN_KEY, via: 'steer' }
}

it('claims the opener and the proven steer by the turn row’s key, never a host-scoped handover', async () => {
  const items = [
    asked('d0', 1),
    asked('d1', 2),
    // Handed over into the turn by the host; the provider never took it.
    asked('d2', 3, TURN_KEY),
    item(
      'said',
      4,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }] },
      TURN_KEY
    ),
    asked('after', 5),
    item(TURN_KEY, 6, {
      kind: 'turn',
      turnId: 'provider-turn-1',
      state: 'completed',
      outcome: 'success',
      userItemId: agentJournalSubmissionKey('d0')
    })
  ]
  const chat = {
    journalReads: async () => ({
      operationWindow: async () => ({
        snapshot: {
          sessionId: 'chat-1',
          cursor: { epoch: 'e', sequence: 6 },
          items,
          submissions: [steered]
        },
        complete: true
      }),
      canonicalItemIds: async (ids: readonly string[]) =>
        ids.map((itemId) => ({ itemId, canonicalItemId: itemId }))
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endedTurn reads only these chat members.
  const ended = await endedTurn(chat as unknown as ConversationChat, 'chat-1', 'provider-turn-1', {
    epoch: 'e',
    sequence: 6
  })
  expect(ended.turnItemId).toBe(TURN_KEY)
  expect(ended.stamps?.map((stamp) => stamp.deliveryId).sort()).toEqual(['d0', 'd1'])
  expect(ended.turnProse).toBe('Done.')
})

// STA-16396: the replied, mirrored and failed adopted ends read a real journal whose sends the
// window finds by index, behind 30 earlier turns it must not need.
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

function journal() {
  const f = turnRowsChat(cleanup)
  for (let index = 0; index < 30; index += 1) {
    f.send(`earlier-${index}`, index * 2 + 1, user(`earlier ${index}`, `delivery-${index}`), {
      turnItemId: `turn-${index}`,
      via: 'start'
    })
    f.item(`turn-${index}`, index * 2 + 2, {
      kind: 'turn',
      turnId: `provider-turn-${index}`,
      state: 'completed',
      outcome: 'success',
      userItemId: `orca:earlier-${index}`
    })
  }
  const chat = { journalReads: async () => f.reads }
  const read = (sequence: number) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endedTurn reads only journalReads.
    endedTurn(chat as unknown as ConversationChat, turnRowsTarget.sessionId, 'provider-turn-target', {
      epoch: turnRowsTarget.epoch,
      sequence
    })
  return { f, read }
}

const failed = {
  kind: 'status' as const,
  tone: 'warning' as const,
  ...agentSessionFailureWords(
    { kind: 'providerResponseFailed' },
    { surface: 'row', agentName: 'Agent' }
  )
}

it('gives a replied end its row, its opener and steered deliveries, and its own prose', async () => {
  const { f, read } = journal()
  f.send('open', 100, user('open', 'delivery-open'), { turnItemId: 'turn-target', via: 'start' })
  f.item('turn-target', 101, {
    kind: 'turn',
    turnId: 'provider-turn-target',
    state: 'completed',
    outcome: 'success',
    userItemId: 'orca:open'
  })
  f.send('steered', 102, user('also this', 'delivery-steered'), {
    turnItemId: 'turn-target',
    via: 'steer'
  })
  f.item(
    'said',
    103,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }] },
    'turn-target'
  )

  const ended = await read(103)
  expect(ended.turnItemId).toBe('turn-target')
  expect(ended.stamps?.map((stamp) => stamp.deliveryId)).toEqual([
    'delivery-open',
    'delivery-steered'
  ])
  expect(ended.turnProse).toBe('Done.')
  expect(ended.lastAssistantMessage).toBe('Done.')
  expect(chatTurnFor('local', 'owner')(ended)).toEqual({})
})

it("gives a mirrored Orca-typed end its last words and failure, and acts for the owner", async () => {
  const { f, read } = journal()
  f.send('typed', 100, user('typed in Orca'), { turnItemId: 'turn-target', via: 'start' })
  f.item('turn-target', 101, {
    kind: 'turn',
    turnId: 'provider-turn-target',
    state: 'completed',
    outcome: 'failure',
    userItemId: 'orca:typed'
  })
  f.item(
    'said',
    102,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Partly done.' }] },
    'turn-target'
  )
  f.item('failed', 103, failed)

  const ended = await read(103)
  expect(ended.lastAssistantMessage).toBe('Partly done.')
  expect(ended.failure?.kind).toBe('providerResponseFailed')
  expect(ended.opener?.itemId).toBe('orca:typed')
  expect(ended.stamps).toEqual([])
  expect(chatTurnFor('local', 'owner')(ended)).toEqual({ turnFor: 'owner' })
})

it('gives a failed adopted end the failure of a turn opened by a send queued turns earlier', async () => {
  const { f, read } = journal()
  // The card's first send, and the one that opened the turn though it was sent at sequence 48.
  f.send('first-try', 70, user('do it'), null, { queuedMessageId: 'card-1' })
  f.send('queued', 100, user('do it'), { turnItemId: 'turn-target', via: 'start' }, {
    queuedMessageId: 'card-1',
    submittedSequence: 48
  })
  f.item('turn-target', 101, {
    kind: 'turn',
    turnId: 'provider-turn-target',
    state: 'completed',
    outcome: 'failure',
    userItemId: 'orca:queued'
  })
  f.item('failed', 102, failed)

  const ended = await read(102)
  expect(ended.failure?.kind).toBe('providerResponseFailed')
  expect(ended.opener?.itemId).toBe('orca:queued')
  expect(chatTurnFor('local', undefined)(ended)).toEqual({ turnFor: 'someone_else' })
  // The window reaches back to the send's head, and holds the card's other send.
  const { snapshot } = await f.reads.operationWindow({
    turnIds: ['provider-turn-target'],
    itemIds: ['provider-turn-target'],
    anchorsOnly: true,
    withoutToolOutput: true
  })
  expect(snapshot.items[0]?.itemId).toBe('orca:earlier-23')
  expect(snapshot.submissions.map((send) => send.clientMessageId)).toEqual([
    'earlier-23',
    'earlier-24',
    'earlier-25',
    'earlier-26',
    'earlier-27',
    'earlier-28',
    'earlier-29',
    'first-try',
    'queued'
  ])
})
