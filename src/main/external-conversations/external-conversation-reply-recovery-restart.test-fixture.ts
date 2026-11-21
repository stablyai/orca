import { vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalRestartOf } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { conversationReplyFill } from './external-conversation-reply-fill'
import {
  ConnectorReplyRecovery,
  type ReplyRecoveryOffers
} from './external-conversation-reply-recovery'

// A chat cut by an Orca restart and the continuation that resumes it, for reply recovery's tests
// (design: slack-reply-lost-restart). Times are real-looking epoch milliseconds around T0.

export const T0 = 1_795_203_315_486
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
const key = agentJournalSubmissionKey

type Window = Pick<AgentJournalSnapshot, 'items' | 'submissions'>

const item = (
  itemId: string,
  sequence: number,
  at: number,
  body: AgentJournalRenderItem['body'],
  turnItemId?: string
): AgentJournalRenderItem => ({
  itemId,
  revision: 1,
  body,
  sequence,
  observedAt: at,
  ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
})

/** A Slack request admitted at `at`. */
export const asked = (deliveryId: string, sequence: number, at: number) =>
  item(key(deliveryId), sequence, at, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'deploy it' }],
    connectorDelivery: { account: 'account-a', conversation: SLACK, deliveryId }
  })

/** Orca's restart continuation, with (current builds) or without (earlier ones) what it resumes. */
export const continued = (
  id: string,
  sequence: number,
  at: number,
  restartOf?: AgentJournalRestartOf
) =>
  item(key(id), sequence, at, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Orca restarted. Resume the original unfinished user task.' }],
    ...(restartOf ? { restartOf } : {})
  })

/** A message the owner typed into the chat in Orca. */
export const typed = (id: string, sequence: number, at: number) =>
  item(key(id), sequence, at, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'hi' }]
  })

export const said = (text: string, sequence: number, at: number, turnItemId: string) =>
  item(
    `said-${sequence}`,
    sequence,
    at,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    turnItemId
  )

/** A root turn row: cut by a restart (no outcome, as the death settlement writes it), running, or
 *  ended successfully at `endedAt`. */
export const turnRow = (
  itemId: string,
  sequence: number,
  opener: string,
  state: 'interrupted' | 'running' | 'completed',
  startedAt: number,
  endedAt?: number
) =>
  item(itemId, sequence, startedAt, {
    kind: 'turn',
    turnId: `tid-${itemId}`,
    state,
    ...(state === 'completed' ? { outcome: 'success' as const } : {}),
    userItemId: key(opener),
    ...(endedAt === undefined ? {} : { completedAt: endedAt })
  })

export const submission = (
  id: string,
  fields: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission => ({
  clientMessageId: id,
  fence: 1,
  payloadFingerprint: id,
  dispatchState: 'accepted',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: 2,
  ...fields
})

export const row = (
  deliveryId: string,
  admittedAt: number | undefined
): JournalConnectorReplyRow => ({
  account: 'account-a',
  deliveryId,
  conversation: SLACK,
  sessionId: 'chat-1',
  epoch: 'e',
  messageId: deliveryId,
  queued: false,
  ...(admittedAt === undefined ? {} : { admittedAt })
})

export function restartFixture(
  initial: Window,
  options: {
    rows: JournalConnectorReplyRow[]
    now: number
    offers?: () => ReplyRecoveryOffers | null
    mirrorsTo?: (sessionId: string, externalId: string, persons: readonly string[]) => boolean
    calls?: string[]
  }
) {
  let snapshot = initial
  const clock = { now: options.now }
  const { rows, calls } = options
  const journal = {
    read: async () => {
      calls?.push('rows')
      return rows.filter((candidate) => !('sent' in candidate))
    },
    fillOutcomes: async (fills: readonly JournalConnectorReplyFill[]) => {
      for (const { account, deliveryId, ...fill } of fills) {
        const target = rows.find((r) => r.account === account && r.deliveryId === deliveryId)
        if (target && !target.fill) {
          target.fill = { ...fill, filledAt: clock.now }
        }
      }
      return fills.length > 0
    },
    sent: async () => {}
  }
  const observers: (() => void)[] = []
  const chat = {
    conversation: async () => ({}),
    journalReads: async () => ({
      operationWindow: async () => {
        calls?.push('journal')
        return {
          snapshot: { sessionId: 'chat-1', cursor: { epoch: 'e', sequence: 999 }, ...snapshot },
          complete: true
        }
      },
      canonicalItemIds: async (ids: readonly string[]) =>
        ids.map((itemId) => ({ itemId, canonicalItemId: itemId }))
    }),
    observeJournalPublications: (_sessionId: string, observer: () => void) => {
      calls?.push('watch')
      observers.push(observer)
      return () => observers.splice(observers.indexOf(observer), 1)
    }
  }
  const make = () =>
    new ConnectorReplyRecovery({
      journal: () => journal,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery calls only these chat members.
      chat: () => chat as never,
      hasSession: () => true,
      isBot: () => true,
      agentOf: () => 'claude',
      fillTurn: conversationReplyFill(
        () => journal,
        () => {}
      ),
      filled: vi.fn(),
      now: () => clock.now,
      ...(options.offers ? { offers: options.offers } : {}),
      ...(options.mirrorsTo ? { mirrorsTo: options.mirrorsTo } : {})
    })
  const recovery = make()
  /** The journal moved: every watch hears it, and the settle after the pause runs. */
  const publish = async (next?: Window) => {
    if (next) {
      snapshot = next
    }
    ;[...observers].forEach((observer) => observer())
    await vi.advanceTimersByTimeAsync(2_000)
  }
  return { rows, recovery, make, publish, observers, clock }
}

/** A list of restart offers kept in memory, standing in for the recovery capsule. */
export function memoryOffers(
  initial: { sessionId: string; work: { kind: 'turn' | 'submission'; id: string } }[]
) {
  let offers = initial
  const listeners = new Set<() => void>()
  return {
    source: (): ReplyRecoveryOffers => ({
      read: async () => offers,
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }),
    set(next: typeof initial) {
      offers = next
      listeners.forEach((listener) => listener())
    }
  }
}
