// A structured send is recorded under the id it went out under. The phone settles the send's bubble
// and any unconfirmed hold once its journal holds that record, or a hand-off of its card, whatever
// the text and wherever, or whether, its row is drawn. Its photo binds to that row when drawn.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import {
  countUserTextOccurrences,
  findLandedImagePreviewEchoes,
  findLandedUnconfirmedSends,
  findQueuedUnconfirmedSends,
  normalizeReconcileText,
  type MobileStructuredSendReachedHost
} from './mobile-native-chat-draft-reconcile'
import {
  appendMobileNativeChatPending,
  type MobileNativeChatPendingMessage
} from './mobile-native-chat-pending-echo'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'
import { mobileStructuredSendReceipts } from './mobile-structured-send-receipts'

const TEXT = 'fix the test'

function user(
  id: string,
  sequence: number,
  blocks: Extract<AgentJournalRenderItem['body'], { kind: 'message' }>['blocks']
): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence,
    observedAt: sequence,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'user', blocks }
  }
}

function said(id: string, sequence: number, text: string): AgentJournalRenderItem {
  return user(id, sequence, [{ type: 'text', text }])
}

function answer(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
  }
}

function submission(
  id: string,
  text: string,
  at: number,
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: `body:${text}`,
    dispatchState: 'accepted',
    providerItemId: `provider-${id}`,
    reason: null,
    submittedAt: at,
    resolvedAt: at,
    ...patch
  }
}

function rejected(id: string, text: string, at: number): AgentJournalSubmission {
  return submission(id, text, at, {
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'provider_write_failed: broken pipe',
    resolvedAt: at + 1
  })
}

type Chat = { messages: NativeChatMessage[]; reachedHost: MobileStructuredSendReachedHost }

/** What the phone holds: the journal drawn with a recorded, rejected send in place as not sent,
 *  and what that journal says reached the host. */
function phone(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]): Chat {
  const sends = mobileStructuredSendReceipts(submissions)
  return {
    messages: projectStructuredAgentSessionMessages(items, [], submissions, {
      rejectedInPlace: true
    }),
    reachedHost: (clientMessageId) => sends.has(clientMessageId)
  }
}

/** One bubble for a structured send, captured against `before`. */
function bubble(
  before: Chat,
  clientMessageId: string,
  text: string,
  images?: string[]
): MobileNativeChatPendingMessage[] {
  const normalizedText = normalizeReconcileText(text)
  return (
    appendMobileNativeChatPending(
      {},
      'pending',
      `pending-${clientMessageId}`,
      {
        draftKey: 'draft',
        draftEditGeneration: 0,
        pendingKey: 'pending',
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(before.messages, normalizedText),
        baselineTailMessageId: before.messages.at(-1)?.id ?? null,
        baselineResolved: true
      },
      text,
      images,
      clientMessageId
    ).pending ?? []
  )
}

/** The bubbles still drawn once `after` is the chat. */
function left(after: Chat, pending: MobileNativeChatPendingMessage[]): string[] {
  const bound = new Set(
    findLandedImagePreviewEchoes(after.messages, pending).map((echo) => echo.pendingId)
  )
  return retireLandedMobileNativeChatPending(after.messages, pending, bound, after.reachedHost).map(
    (item) => item.id
  )
}

/** Whether an ack-lost send under `clientMessageId` is still held once `after` is the chat. */
function held(
  before: Chat,
  after: Chat,
  clientMessageId: string,
  text: string,
  cards: { messageId: string; text: string }[] = []
): boolean {
  const entry = {
    draftKey: 'draft',
    pendingKey: 'pending',
    text,
    normalizedText: normalizeReconcileText(text),
    baselineTailMessageId: before.messages.at(-1)?.id ?? null,
    clientMessageId,
    deadline: null
  }
  return (
    findLandedUnconfirmedSends(after.messages, [entry], after.reachedHost).length === 0 &&
    findQueuedUnconfirmedSends(cards, [entry]).length === 0
  )
}

const drawn = (chat: Chat, clientMessageId: string): boolean =>
  chat.messages.some((message) => message.id === agentJournalSubmissionKey(clientMessageId))

const ORIGINAL = rejected('m1', TEXT, 10)
const BEFORE = phone([answer('hi', 5), said('m1', 11, TEXT)], [ORIGINAL])

describe('a same-text resend after a not-sent message', () => {
  it('stays unsettled until the journal holds it, never settled by the original', () => {
    expect(left(BEFORE, bubble(BEFORE, 'm2', TEXT))).toEqual(['pending-m2'])
    expect(held(BEFORE, BEFORE, 'm2', TEXT)).toBe(true)
  })

  // The projection drops the original once the resend is recorded after its rejection.
  it('settles once the journal holds it, with the original gone', () => {
    const after = phone(
      [answer('hi', 5), said('m1', 11, TEXT), said('m2', 20, TEXT), answer('done', 21)],
      [ORIGINAL, submission('m2', TEXT, 20)]
    )
    expect(drawn(after, 'm1')).toBe(false)
    expect(left(after, bubble(BEFORE, 'm2', TEXT))).toEqual([])
    expect(held(BEFORE, after, 'm2', TEXT)).toBe(false)
  })
})

describe('a send whose own row arrives already not sent', () => {
  const after = phone(
    [answer('hi', 5), said('m1', 11, TEXT), said('m2', 21, 'later')],
    [ORIGINAL, rejected('m2', 'later', 20)]
  )

  it('settles an ack-lost send, so no "Delivery unconfirmed" banner follows', () => {
    expect(after.messages.at(-1)).toMatchObject({
      id: agentJournalSubmissionKey('m2'),
      unsent: true
    })
    expect(held(BEFORE, after, 'm2', 'later')).toBe(false)
  })

  it('retires its bubble, so no copy stays beside the not-sent row', () => {
    expect(left(after, bubble(BEFORE, 'm2', 'later'))).toEqual([])
  })
})

// The newest row at send time can be one the host rejects only later: it moves that row to the
// rejection, past the new send's own row (R1P-1).
describe('a send whose boundary row the host moves past it', () => {
  const before = phone([answer('hi', 5), said('m1', 10, 'first')], [])
  const after = phone(
    [
      answer('hi', 5),
      user('m2', 20, [{ type: 'image-ref', path: '/host/a.png' }]),
      said('m1', 21, 'first')
    ],
    [rejected('m1', 'first', 20), submission('m2', '', 20)]
  )

  it('binds its photo to its own row and retires its bubble', () => {
    const pending = bubble(before, 'm2', '', ['file:///a.jpg'])
    expect(findLandedImagePreviewEchoes(after.messages, pending)).toEqual([
      {
        pendingId: 'pending-m2',
        messageId: agentJournalSubmissionKey('m2'),
        images: ['file:///a.jpg']
      }
    ])
    expect(left(after, pending)).toEqual([])
  })

  it('settles an ack-lost send there too', () => {
    expect(held(before, after, 'm2', '')).toBe(false)
  })
})

describe('a captioned photo send', () => {
  const photo = (id: string, sequence: number) =>
    user(id, sequence, [
      { type: 'text', text: 'look' },
      { type: 'image-ref', path: `/host/${id}.png` }
    ])

  it('binds to its own row, never an older one with the same caption, not sent or delivered', () => {
    const before = phone([photo('m1', 10), photo('m3', 12)], [rejected('m1', 'look', 10)])
    const pending = bubble(before, 'm2', 'look', ['file:///b.jpg'])
    expect(left(before, pending)).toEqual(['pending-m2'])
    const after = phone(
      [photo('m1', 10), photo('m3', 12), photo('m2', 21)],
      [rejected('m1', 'look', 10), rejected('m2', 'look', 20)]
    )
    expect(findLandedImagePreviewEchoes(after.messages, pending)).toEqual([
      {
        pendingId: 'pending-m2',
        messageId: agentJournalSubmissionKey('m2'),
        images: ['file:///b.jpg']
      }
    ])
    expect(left(after, pending)).toEqual([])
  })
})

// Two quick sends of the same text: the first recorded and rejected, the second delivered. Each
// settles on its own record, whichever state the phone first sees (R1P-3).
describe('two quick sends of the same text', () => {
  const before = phone([answer('a0', 5)], [])
  const pending = () => [...bubble(before, 'm1', TEXT), ...bubble(before, 'm2', TEXT)]

  it("settles only the first while only the first's record is there", () => {
    const firstOnly = phone([answer('a0', 5), said('m1', 11, TEXT)], [rejected('m1', TEXT, 10)])
    expect(left(firstOnly, pending())).toEqual(['pending-m2'])
  })

  it('settles both at once, though the first row is hidden by the copy sent after it', () => {
    const both = phone(
      [answer('a0', 5), said('m1', 11, TEXT), said('m2', 12, TEXT)],
      [rejected('m1', TEXT, 10), submission('m2', TEXT, 12)]
    )
    expect(drawn(both, 'm1')).toBe(false)
    expect(left(both, pending())).toEqual([])
  })
})

// A send's own row can be hidden, or never exist, before the phone ever draws it: the journal still
// holds the send, or the hand-off of the card the host made of it.
describe('a send the chat never draws under its own id', () => {
  it('settles a held send whose card went out under a fresh id after its answer was lost', () => {
    const after = phone(
      [answer('hi', 5), said('drained', 20, 'run tests')],
      [submission('drained', 'run tests', 20, { queuedMessageId: 'op-a' })]
    )
    expect(held(BEFORE, after, 'op-a', 'run tests')).toBe(false)
  })

  it('retires a bubble whose row a same-text copy hid before the phone drew it', () => {
    const after = phone(
      [said('o', 5, 'go'), said('n', 7, 'go')],
      [{ ...rejected('o', 'go', 5), resolvedAt: 6 }, submission('n', 'go', 7)]
    )
    expect(drawn(after, 'o')).toBe(false)
    expect(left(after, bubble(BEFORE, 'o', 'go', ['file:///o.jpg']))).toEqual([])
  })

  it('retires a bubble kept as a card that then went out under a fresh id', () => {
    const after = phone(
      [said('o', 5, 'go'), said('fresh', 8, 'go')],
      [
        { ...rejected('o', 'go', 5), keptAsQueuedMessageId: 'o' },
        submission('fresh', 'go', 8, { queuedMessageId: 'o' })
      ]
    )
    expect(drawn(after, 'o')).toBe(false)
    expect(left(after, bubble(BEFORE, 'o', 'go'))).toEqual([])
  })

  it('settles a held send on its own card, never on another card with its text', () => {
    expect(
      held(BEFORE, BEFORE, 'op-a', 'run tests', [{ messageId: 'op-a', text: 'run tests' }])
    ).toBe(false)
    expect(
      held(BEFORE, BEFORE, 'op-a', 'run tests', [{ messageId: 'other', text: 'run tests' }])
    ).toBe(true)
  })
})

describe('a send the host has recorded but not yet answered', () => {
  it('settles on its pending record: its row is drawn as sent', () => {
    const after = phone(
      [answer('hi', 5), said('m2', 20, 'later')],
      [submission('m2', 'later', 20, { dispatchState: 'pending', resolvedAt: null })]
    )
    expect(left(after, bubble(BEFORE, 'm2', 'later'))).toEqual([])
    expect(held(BEFORE, after, 'm2', 'later')).toBe(false)
  })
})

describe('what never settles a send', () => {
  it('another send of the same text', () => {
    const after = phone([said('z', 5, 'go')], [submission('z', 'go', 5)])
    expect(left(after, bubble(BEFORE, 'o', 'go'))).toEqual(['pending-o'])
    expect(held(BEFORE, after, 'o', 'go')).toBe(true)
  })

  it('a journal without its record yet', () => {
    const empty = phone([], [])
    expect(left(empty, bubble(BEFORE, 'o', 'go'))).toEqual(['pending-o'])
    expect(held(BEFORE, empty, 'o', 'go')).toBe(true)
  })

  it("another card's hand-off", () => {
    const after = phone(
      [said('fresh', 5, 'go')],
      [submission('fresh', 'go', 5, { queuedMessageId: 'card-other' })]
    )
    expect(left(after, bubble(BEFORE, 'o', 'go'))).toEqual(['pending-o'])
    expect(held(BEFORE, after, 'o', 'go')).toBe(true)
  })
})
