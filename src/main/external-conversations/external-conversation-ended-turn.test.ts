// Whom an ended turn acts for, read from its journal as the Slack mirror and an adopted turn read it:
// a paired device Orca can't place as the owner typing a steer the provider took into the turn makes
// it no longer the owner's; a send only scoped to the turn, which the provider never took, does not.
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { endedTurn, endedTurnAttribution } from './external-conversation-ended-turn'
import { chatTurnFor } from './external-conversation-turn-state'
import type { ConversationChat } from './external-conversation-chat'

const TURN = 'turn-1'
const CURSOR = { epoch: 'e1', sequence: 10 }
const host = { by: 'host' }
const unclaimed = { by: 'device', deviceId: 'd4' }

let seq = 0
const row = (itemId: string, body: unknown, extra: Record<string, unknown> = {}) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: journal rows with only the fields the readers read.
  ({
    itemId,
    revision: 1,
    sequence: ++seq,
    observedAt: seq,
    body,
    ...extra
  }) as AgentJournalRenderItem
const message = (typedBy: unknown) => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'go' }],
  typedBy
})
const send = (clientMessageId: string, answeredInTurn?: unknown) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a submission with only the fields the readers read.
  ({
    clientMessageId,
    origin: 'client',
    source: { kind: 'user' },
    dispatchState: 'accepted',
    ...(answeredInTurn ? { answeredInTurn } : {})
  }) as unknown as AgentJournalSubmission

/** The owner's host-typed turn, with a paired device's send steered in: taken by the provider, or
 *  only scoped to the turn. */
function journal(steer: 'taken' | 'scoped') {
  seq = 0
  const steered = agentJournalSubmissionKey('c2')
  const items = [
    row('u1', message(host)),
    row('t1', { kind: 'turn', turnId: TURN, state: 'completed', userItemId: 'u1' }),
    row(steered, message(unclaimed), { turnScope: { kind: 'turn', turnItemId: 't1' } })
  ]
  const submissions = [
    send('c2', steer === 'taken' ? { turnItemId: 't1', via: 'steer' } : undefined)
  ]
  return { items, submissions }
}

function chatOf(steer: 'taken' | 'scoped') {
  const { items, submissions } = journal(steer)
  const opener = items[0]!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the readers call only these journal reads.
  return {
    journalReads: async () => ({
      operationWindow: async () => ({ snapshot: { items, submissions, cursor: CURSOR } }),
      canonicalItemIds: async () => [],
      turnAttribution: async () => ({
        cursor: CURSOR,
        turnItemId: 't1',
        opener,
        stamps: [],
        messages: steer === 'taken' ? [opener, items[2]!] : [opener]
      })
    })
  } as unknown as ConversationChat
}

const ownerThread = chatTurnFor('local', 'owner')

describe('an ended turn of the owner’s thread', () => {
  it('is never the owner’s once a device Orca can’t place as the owner steered into it', async () => {
    const full = await endedTurn(chatOf('taken'), 'chat', TURN, CURSOR)
    expect(full.typedByAnother).toBe(true)
    expect(ownerThread(full).turnFor).toBe('someone_else')
    const indexed = await endedTurnAttribution(chatOf('taken'), 'chat', TURN, CURSOR)
    expect(indexed.typedByAnother).toBe(true)
    expect(ownerThread(indexed).turnFor).toBe('someone_else')
  })

  it('stays the owner’s when the provider never took that send into the turn', async () => {
    const full = await endedTurn(chatOf('scoped'), 'chat', TURN, CURSOR)
    expect(full.typedByAnother).toBeUndefined()
    expect(ownerThread(full).turnFor).toBe('owner')
    const indexed = await endedTurnAttribution(chatOf('scoped'), 'chat', TURN, CURSOR)
    expect(ownerThread(indexed).turnFor).toBe('owner')
  })
})
