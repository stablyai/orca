import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { conversationReplyFill } from './external-conversation-reply-fill'
import { ConnectorReplyRecovery } from './external-conversation-reply-recovery'

// Design item 125 §3 and §8, recovery: rows no live turn end filled are settled from the journal:
// the turn they joined (by its row's own key), a rejection before any turn, a withdrawal or turn
// end while nothing else listens, with the turn's own prose and the chat's real kind.

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
const TURN_KEY = 'item:turn-1'

const stamp = (deliveryId: string) => ({
  account: 'account-a',
  conversation: SLACK,
  deliveryId
})

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

const asked = (deliveryId: string, sequence: number, messageId = deliveryId) =>
  item(agentJournalSubmissionKey(messageId), sequence, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'review' }],
    connectorDelivery: stamp(deliveryId)
  })

const said = (text: string, sequence: number, turnItemId: string) =>
  item(
    `said-${sequence}`,
    sequence,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    turnItemId
  )

const turn = (
  sequence: number,
  opener: string,
  state: 'completed' | 'running' = 'completed',
  key = TURN_KEY
) =>
  item(key, sequence, {
    kind: 'turn',
    turnId: `provider-${key}`,
    state,
    ...(state === 'completed' ? { outcome: 'success' as const } : {}),
    userItemId: agentJournalSubmissionKey(opener)
  })

const submission = (
  messageId: string,
  fields: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission => ({
  clientMessageId: messageId,
  fence: 1,
  payloadFingerprint: messageId,
  dispatchState: 'accepted',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: 2,
  ...fields
})

const row = (deliveryId: string, messageId = deliveryId): JournalConnectorReplyRow => ({
  account: 'account-a',
  deliveryId,
  conversation: SLACK,
  sessionId: 'chat-1',
  epoch: 'e',
  messageId,
  queued: false
})

function fixture(
  initial: Pick<AgentJournalSnapshot, 'items' | 'submissions'>,
  { bot = false, exists = true, rows = [row('d1')] } = {}
) {
  let snapshot = initial
  const observers: (() => void)[] = []
  const journal = {
    read: async () => rows.filter((candidate) => !('sent' in candidate)),
    fillOutcomes: async (fills: readonly JournalConnectorReplyFill[]) => {
      for (const { account, deliveryId, ...fill } of fills) {
        const target = rows.find((r) => r.account === account && r.deliveryId === deliveryId)
        if (target && !target.fill) {
          target.fill = { ...fill, filledAt: 1 }
        }
      }
      return fills.length > 0
    },
    sent: async () => {}
  }
  const filled = vi.fn()
  const chat = {
    conversation: async () => ({}),
    journalReads: async () => ({
      operationWindow: async () => ({
        snapshot: { sessionId: 'chat-1', cursor: { epoch: 'e', sequence: 99 }, ...snapshot },
        complete: true
      }),
      canonicalItemIds: async (ids: readonly string[]) =>
        ids.map((itemId) => ({ itemId, canonicalItemId: itemId }))
    }),
    observeJournalPublications: (_sessionId: string, observer: () => void) => {
      observers.push(observer)
      return () => observers.splice(observers.indexOf(observer), 1)
    }
  }
  const recovery = new ConnectorReplyRecovery({
    journal: () => journal,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery calls only these chat members.
    chat: () => chat as never,
    hasSession: () => exists,
    isBot: () => bot,
    agentOf: () => 'claude',
    fillTurn: conversationReplyFill(
      () => journal,
      () => {}
    ),
    filled
  })
  const publish = async () => {
    observers.forEach((observer) => observer())
    await vi.advanceTimersByTimeAsync(2_000)
  }
  const write = (next: Pick<AgentJournalSnapshot, 'items' | 'submissions'>) => {
    snapshot = next
  }
  return { rows, recovery, filled, publish, observers, write }
}

describe('recovery from the journal', () => {
  it('fills a steered request from its turn by the turn row’s own key, with that turn’s prose', async () => {
    const f = fixture({
      items: [
        asked('d0', 1),
        asked('d1', 2),
        said('Here it is.', 3, TURN_KEY),
        // A later steer after the turn's last words: the latest-request reader would see none.
        asked('later', 4),
        turn(5, 'd0')
      ],
      submissions: [submission('d1', { answeredInTurn: { turnItemId: TURN_KEY, via: 'steer' } })]
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', prose: 'Here it is.' })
  })

  it('keeps a quiet marker as the answer in a chat that is no bot’s', async () => {
    const f = fixture({
      items: [asked('d1', 1), said('NO_REPLY', 2, TURN_KEY), turn(3, 'd1')],
      submissions: []
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', prose: 'NO_REPLY' })
  })

  it('fills rejections before any turn opens and preserves a recorded reason', async () => {
    const f = fixture(
      {
        items: [asked('d1', 1), asked('d2', 2)],
        submissions: [
          submission('d1', { dispatchState: 'rejected', answeredInTurn: null }),
          submission('d2', {
            dispatchState: 'rejected',
            answeredInTurn: null,
            rejection: agentSessionFailureFact('notSignedIn')
          })
        ]
      },
      { rows: [row('d1'), row('d2')] }
    )
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('failed')
    expect(f.rows[1]?.fill).toMatchObject({
      outcome: 'failed',
      failure: { category: 'signed_out', agentName: 'Claude' }
    })
  })

  it('fills a turn the usage limit ended with the limit and its reset', async () => {
    const f = fixture({
      items: [
        asked('d1', 1),
        item(
          'limit-row',
          2,
          {
            kind: 'status',
            tone: 'warning',
            ...agentSessionFailureWords(
              agentSessionFailureFact('usageLimitReached', {
                usageLimit: { window: 'session', resetsAt: 1_800_000_000_000 }
              }),
              { agentName: 'Claude', provider: 'claude', surface: 'row' }
            )
          },
          TURN_KEY
        ),
        item(TURN_KEY, 3, {
          kind: 'turn',
          turnId: 'provider-turn',
          state: 'completed',
          outcome: 'failure',
          userItemId: agentJournalSubmissionKey('d1')
        })
      ],
      submissions: [submission('d1')]
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toMatchObject({
      outcome: 'failed',
      failure: {
        category: 'usage_limit',
        agentName: 'Claude',
        usageLimit: { window: 'session', resetsAt: 1_800_000_000_000 }
      }
    })
  })

  it('watches a chat from admission, and wakes the sender once a withdrawal fills its row', async () => {
    const f = fixture({ items: [], submissions: [] })
    f.recovery.admitted('chat-1')
    expect(f.observers).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    f.filled.mockClear()
    // The withdraw transaction filled it; its publication is all that comes.
    f.rows[0]!.fill = { outcome: 'withdrawn', answerDeliveryId: 'd1', filledAt: 3 }
    await f.publish()
    expect(f.filled).toHaveBeenCalled()
  })
})

describe('recovery, round 2', () => {
  it('keeps an outstanding send with no evidence unfilled and watched', async () => {
    const f = fixture({
      items: [asked('d1', 1)],
      submissions: [submission('d1', { dispatchState: 'unknown' })]
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    expect(f.observers).toHaveLength(1)
  })

  it('wakes the sender when a deleted chat’s rows read not found', async () => {
    const f = fixture({ items: [], submissions: [] }, { exists: false })
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('not_found')
    expect(f.filled).toHaveBeenCalled()
  })

  it('settles X while Y is owed, then Y, under one live watch', async () => {
    const f = fixture({ items: [], submissions: [] }, { rows: [row('x1'), row('y1')] })
    f.recovery.admitted('chat-1')
    // X ends while Y waits behind it; no completion is published for X.
    f.write({
      items: [asked('x1', 1), said('X done.', 2, TURN_KEY), turn(3, 'x1'), asked('y1', 4)],
      submissions: []
    })
    await f.publish()
    expect(f.rows.map((r) => r.fill?.prose ?? null)).toEqual(['X done.', null])
    expect(f.observers).toHaveLength(1)
    f.write({
      items: [
        asked('x1', 1),
        said('X done.', 2, TURN_KEY),
        turn(3, 'x1'),
        asked('y1', 4),
        said('Y done.', 5, 'item:turn-2'),
        turn(6, 'y1', 'completed', 'item:turn-2')
      ],
      submissions: []
    })
    await f.publish()
    expect(f.rows.map((r) => r.fill?.prose ?? null)).toEqual(['X done.', 'Y done.'])
    expect(f.observers).toHaveLength(0)
  })

  it('answers an edited queued card through the message it was handed off as', async () => {
    // The row names the card; the turn opened on the handed-off submission, which carries the stamp.
    const f = fixture(
      {
        items: [
          asked('d1', 1, 'handoff-1'),
          said('Edited answer.', 2, TURN_KEY),
          turn(3, 'handoff-1')
        ],
        submissions: []
      },
      { rows: [{ ...row('d1', 'card-1'), queued: true }] }
    )
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', prose: 'Edited answer.' })
  })
})

describe('recovery, round 3', () => {
  it('fills a provider exit before a later turn as interrupted, keeping the watch for a queued request', async () => {
    const f = fixture(
      {
        // X's provider exited before taking it; another message opened the turn that followed, and
        // Z waits behind it.
        items: [asked('x1', 1), asked('other', 2), turn(3, 'other'), asked('z1', 4)],
        submissions: [
          submission('x1', {
            dispatchState: 'unknown',
            recovered: true,
            reason: 'provider_exited_before_acknowledgement'
          })
        ]
      },
      { rows: [row('x1'), row('z1')] }
    )
    await f.recovery.boot()
    expect(f.rows.map((r) => r.fill?.outcome ?? null)).toEqual(['interrupted', null])
    expect(f.observers).toHaveLength(1)
    f.filled.mockClear()
    f.rows[1]!.fill = { outcome: 'withdrawn', answerDeliveryId: 'z1', filledAt: 5 }
    await f.publish()
    expect(f.filled).toHaveBeenCalled()
  })
})

describe('recovery, round 4', () => {
  it('keeps a request its own unverifiable turn claims owed, then fills it once the turn has a verdict', async () => {
    const unverifiable = { ...turn(3, 'x1'), body: { ...turn(3, 'x1').body, outcome: undefined } }
    const f = fixture(
      { items: [asked('x1', 1), said('X done.', 2, TURN_KEY), unverifiable], submissions: [] },
      { rows: [row('x1')] }
    )
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    expect(f.observers).toHaveLength(1)
    // Provider evidence refines the same turn.
    f.write({
      items: [asked('x1', 1), said('X done.', 2, TURN_KEY), turn(3, 'x1')],
      submissions: []
    })
    await f.publish()
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', prose: 'X done.' })
  })
})
