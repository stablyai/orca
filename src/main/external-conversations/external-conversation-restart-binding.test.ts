import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalRestartOf } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { BINDING_UNKNOWN, restartBinding } from './external-conversation-restart-binding'

// What a restart continuation resumes (design: slack-reply-lost-restart, D2 §2): exactly one match
// before it, a turn that ended interrupted or a send in doubt, nothing in between, at most four hops;
// anything else binds nothing.

const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
const key = agentJournalSubmissionKey

const item = (itemId: string, sequence: number, body: AgentJournalRenderItem['body']) => ({
  itemId,
  revision: 1,
  body,
  sequence,
  observedAt: sequence
})

const asked = (id: string, sequence: number) =>
  item(key(id), sequence, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'ask' }],
    connectorDelivery: { account: 'a', conversation: SLACK, deliveryId: id }
  })

const continuation = (id: string, sequence: number, restartOf: AgentJournalRestartOf) =>
  item(key(id), sequence, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Orca restarted. Resume.' }],
    restartOf
  })

const turn = (
  itemId: string,
  sequence: number,
  opener: string,
  state: 'interrupted' | 'completed' = 'interrupted'
) =>
  item(itemId, sequence, {
    kind: 'turn',
    turnId: `tid-${itemId}`,
    state,
    ...(state === 'completed' ? { outcome: 'success' as const } : {}),
    userItemId: key(opener)
  })

const submission = (id: string, fields: Partial<AgentJournalSubmission> = {}) => ({
  clientMessageId: id,
  fence: 1,
  payloadFingerprint: id,
  dispatchState: 'accepted' as const,
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: 2,
  ...fields
})

function bind(
  items: AgentJournalRenderItem[],
  continuationId: string,
  {
    submissions = [] as AgentJournalSubmission[],
    chainMax = 4,
    unreadable = undefined as string | undefined
  } = {}
) {
  const window = { items, submissions }
  const message = items.find((candidate) => candidate.itemId === key(continuationId))!
  return restartBinding(window, message, {
    chainMax,
    openerOf: async (turnItemId) => {
      if (turnItemId === unreadable) {
        return undefined
      }
      const row = items.find((candidate) => candidate.itemId === turnItemId)
      const userItemId = row?.body.kind === 'turn' ? row.body.userItemId : undefined
      return items.find((candidate) => candidate.itemId === userItemId) ?? null
    }
  })
}

const ids = (binding: Awaited<ReturnType<typeof bind>>) =>
  binding === BINDING_UNKNOWN ? BINDING_UNKNOWN : (binding?.stamps.map((s) => s.deliveryId) ?? null)

describe('restart continuation binding', () => {
  it('binds a turn by its lifecycle id, by its row key, and a send that became that turn', async () => {
    const items = [
      asked('d1', 1),
      turn('t1', 2, 'd1'),
      continuation('c-turn', 3, { kind: 'turn', id: 'tid-t1' })
    ]
    expect(ids(await bind(items, 'c-turn'))).toEqual(['d1'])
    items[2] = continuation('c-item', 3, { kind: 'turn-item', id: 't1' })
    expect(ids(await bind(items, 'c-item'))).toEqual(['d1'])
    items[2] = continuation('c-send', 3, { kind: 'submission', id: 'd1' })
    expect(ids(await bind(items, 'c-send'))).toEqual(['d1'])
  })

  it('binds a send that never became a turn only while its dispatch is in doubt', async () => {
    const items = [asked('d1', 1), continuation('c', 2, { kind: 'submission', id: 'd1' })]
    const doubt = submission('d1', { dispatchState: 'unknown' })
    expect(ids(await bind(items, 'c', { submissions: [doubt] }))).toEqual(['d1'])
    expect(await bind(items, 'c', { submissions: [submission('d1')] })).toBeNull()
  })

  it('fails closed on no match, a turn that did not end interrupted, a root between, or a client send', async () => {
    const missing = [asked('d1', 1), continuation('c', 2, { kind: 'turn', id: 'nope' })]
    expect(await bind(missing, 'c')).toBeNull()
    const answered = [
      asked('d1', 1),
      turn('t1', 2, 'd1', 'completed'),
      continuation('c', 3, { kind: 'turn-item', id: 't1' })
    ]
    expect(await bind(answered, 'c')).toBeNull()
    const movedOn = [
      asked('d1', 1),
      turn('t1', 2, 'd1'),
      asked('d2', 3),
      turn('t2', 4, 'd2', 'completed'),
      continuation('c', 5, { kind: 'turn-item', id: 't1' })
    ]
    expect(await bind(movedOn, 'c')).toBeNull()
    const forged = [
      asked('d1', 1),
      turn('t1', 2, 'd1'),
      continuation('c', 3, { kind: 'turn-item', id: 't1' })
    ]
    expect(
      await bind(forged, 'c', { submissions: [submission('c', { origin: 'client' })] })
    ).toBeNull()
  })

  it('fails closed on two turns with the same lifecycle id', async () => {
    const twin = { ...turn('t2', 3, 'd1'), body: { ...turn('t2', 3, 'd1').body, turnId: 'tid-t1' } }
    const items = [
      asked('d1', 1),
      turn('t1', 2, 'd1'),
      twin,
      continuation('c', 4, { kind: 'turn', id: 'tid-t1' })
    ]
    expect(await bind(items, 'c')).toBeNull()
  })

  it('follows a chain of four restarts, and fails the whole chain closed past the fourth hop', async () => {
    // d1's turn cut, resumed by c1, whose turn was cut, resumed by c2 ... each hop one turn.
    const items: AgentJournalRenderItem[] = [asked('d1', 1), turn('t0', 2, 'd1')]
    for (let hop = 1; hop <= 5; hop += 1) {
      items.push(continuation(`c${hop}`, hop * 2 + 1, { kind: 'turn-item', id: `t${hop - 1}` }))
      items.push(turn(`t${hop}`, hop * 2 + 2, `c${hop}`))
    }
    expect(ids(await bind(items.slice(0, 10), 'c4'))).toEqual(['d1'])
    // Past the fourth hop the whole chain binds nothing, so its requests release.
    expect(await bind(items, 'c5')).toBeNull()
  })

  it('is unknown, not unbound, when an opener it needs can’t be read', async () => {
    const items = [
      asked('d1', 1),
      turn('t1', 2, 'd1'),
      continuation('c', 3, { kind: 'turn', id: 'tid-t1' })
    ]
    expect(await bind(items, 'c', { unreadable: 't1' })).toBe(BINDING_UNKNOWN)
    items[2] = continuation('c', 3, { kind: 'submission', id: 'd1' })
    expect(await bind(items, 'c', { unreadable: 't1' })).toBe(BINDING_UNKNOWN)
  })
})
