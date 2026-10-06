import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import {
  QUEUED_MESSAGE_PAUSED_KEPT,
  QUEUED_MESSAGE_PAUSED_SEND_FAILED
} from '../../../src/shared/agent-session-wire'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import {
  mobileQueueHasResumableCard,
  mobileQueuePauseLabel,
  mobileQueuedMessageCards
} from './mobile-structured-queued-message-cards'

/** A returned card as the host publishes it: the refusal's sentence and its typed fact. */
function returnedAs(fact: Parameters<typeof agentSessionFailureWords>[0]) {
  const { reason, rejection } = agentSessionFailureWords(fact, { surface: 'rejection' })
  return { state: 'returned' as const, returnedReason: reason, returnedRejection: rejection }
}

function draft(overrides: Partial<AgentSessionQueuedMessage> & { messageId: string }) {
  return {
    position: 1,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `body of ${overrides.messageId}` }]
    },
    state: 'waiting' as const,
    ...overrides
  }
}

describe('mobileQueuedMessageCards', () => {
  it('renders nothing without a published list', () => {
    expect(mobileQueuedMessageCards(null, [], { pendingPrompt: false })).toEqual([])
    expect(mobileQueuedMessageCards([], [], { pendingPrompt: false })).toEqual([])
  })

  it('captions nothing on a plain waiting draft, as the desktop row', () => {
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a' })], [], {
      pendingPrompt: false
    })
    expect(card).toEqual({
      messageId: 'a',
      text: 'body of a',
      state: 'waiting',
      paused: false,
      needsAttention: false,
      caption: null,
      attribution: null
    })
  })

  it('captions a waiting draft behind a pending prompt', () => {
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a' })], [], {
      pendingPrompt: true
    })
    expect(card?.caption).toBe('Waiting for your answer')
  })

  it('captions nothing on a waiting card of a paused queue; its pause row explains', () => {
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a' })], [], {
      pendingPrompt: false,
      queuePaused: true
    })
    expect(card?.caption).toBeNull()
    expect(card?.paused).toBe(false)
    expect(card?.needsAttention).toBe(false)
  })

  it("keeps a card's own failed send and reads a prompt's wait as queued under a paused queue", () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'a', paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }),
        draft({ messageId: 'b', position: 2 })
      ],
      [],
      { pendingPrompt: true, queuePaused: true }
    )
    expect(cards.map((card) => card.caption)).toEqual(["Couldn't send — tap Send to retry", null])
    expect(cards[0]?.paused).toBe(true)
  })

  it('finds something for Resume to send only in a waiting card with no hold, ahead of a returned one', () => {
    const resumable = (drafts: AgentSessionQueuedMessage[]) =>
      mobileQueueHasResumableCard(
        mobileQueuedMessageCards(drafts, [], { pendingPrompt: false, queuePaused: true })
      )
    const returned = draft({
      messageId: 'r',
      ...returnedAs(agentSessionFailureFact('hostRestarted'))
    })
    const failed = draft({
      messageId: 'f',
      paused: true,
      pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
    })
    const waiting = draft({ messageId: 'w', position: 2 })
    expect(resumable([returned])).toBe(false)
    expect(resumable([returned, waiting])).toBe(false)
    expect(resumable([failed])).toBe(false)
    expect(resumable([failed, waiting])).toBe(true)
    expect(resumable([waiting, { ...returned, position: 3 }])).toBe(true)
    // A kept card is held on its own, like a failed one: the drain goes past it.
    const kept = draft({ messageId: 'k', paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_KEPT })
    expect(resumable([kept])).toBe(false)
    expect(resumable([kept, waiting])).toBe(true)
  })

  // The host kept it unsent across a restart or a close; the cards behind it are not held by it.
  it('captions a kept card as not sent yet, and leaves the cards behind it plainly queued', () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'k', paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_KEPT }),
        draft({ messageId: 'b', position: 2 })
      ],
      [],
      { pendingPrompt: false }
    )
    expect(cards.map(({ caption, needsAttention }) => ({ caption, needsAttention }))).toEqual([
      { caption: 'Not sent yet — tap Send to send it', needsAttention: false },
      { caption: null, needsAttention: false }
    ])
  })

  it('words the paused queue by reason, and one this build does not know as a plain pause', () => {
    expect(mobileQueuePauseLabel({ reason: 'stopped' })).toBe(
      'Queue paused because you interrupted'
    )
    expect(mobileQueuePauseLabel({ reason: 'restarted' })).toBe(
      'Queue paused because Orca restarted'
    )
    expect(mobileQueuePauseLabel({ reason: 'cleared' })).toBe(
      'Queue paused after you cleared the conversation'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reason newer than this build's union, as a newer host would send it.
    const newer = { reason: 'later_reason' } as never
    expect(mobileQueuePauseLabel(newer)).toBe('Queue paused')
  })

  it('captions a reasonless pause as a plain pause, promising no release rule', () => {
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a', paused: true })], [], {
      pendingPrompt: false
    })
    expect(card?.caption).toBe('Paused')
  })

  it("shows a returned card with the provider's own words and holds drafts behind it", () => {
    const refused = agentSessionFailureFact('providerRejected', {
      detail: { text: 'Steering is unavailable', audience: 'person' }
    })
    const cards = mobileQueuedMessageCards(
      [draft({ messageId: 'a', ...returnedAs(refused) }), draft({ messageId: 'b', position: 2 })],
      [],
      { pendingPrompt: false }
    )
    expect(cards[0]?.caption).toContain('Steering is unavailable')
    expect(cards[0]?.state).toBe('returned')
    expect(cards[0]?.needsAttention).toBe(true)
    expect(cards[1]?.caption).toBe('Waiting — a message ahead needs attention')
    expect(cards[1]?.needsAttention).toBe(false)
  })

  it('hides a waiting card once its hand-off arrived, never a returned one', () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'returned', ...returnedAs(agentSessionFailureFact('hostRestarted')) }),
        draft({ messageId: 'drained', position: 2 }),
        draft({ messageId: 'waiting', position: 3 })
      ],
      [
        { queuedMessageId: 'returned', dispatchState: 'rejected' },
        { queuedMessageId: 'drained', dispatchState: 'pending' }
      ],
      { pendingPrompt: false }
    )
    expect(cards.map((card) => card.messageId)).toEqual(['returned', 'waiting'])
    expect(cards[1]?.caption).toBe('Waiting — a message ahead needs attention')
  })

  it('shows a draft a Stop requeued beside its rejected hand-off', () => {
    // The requeued draft keeps its id; its withdrawn hand-off stays in the journal as rejected and
    // the transcript hides it, so hiding the card too would leave the text unreachable.
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'requeued' }),
        draft({ messageId: 'sending', position: 2 }),
        draft({ messageId: 'sent', position: 3 })
      ],
      [
        { queuedMessageId: 'requeued', dispatchState: 'rejected' },
        { queuedMessageId: 'sending', dispatchState: 'pending' },
        { queuedMessageId: 'sent', dispatchState: 'accepted' }
      ],
      { pendingPrompt: false }
    )
    expect(cards.map((card) => card.messageId)).toEqual(['requeued'])
  })

  it('maps a Stop-withdrawn returned card to its own English copy', () => {
    const [card] = mobileQueuedMessageCards(
      [draft({ messageId: 'a', ...returnedAs(agentSessionFailureFact('cancelled')) })],
      [],
      { pendingPrompt: false }
    )
    expect(card?.caption).toBe('Stopped before it was sent')
  })

  it('reads a Stop withdrawal from the fact, whatever sentence rides beside it', () => {
    const [card] = mobileQueuedMessageCards(
      [
        draft({
          messageId: 'a',
          state: 'returned',
          returnedReason: 'This message was withdrawn before the agent started it.',
          returnedRejection: { kind: 'cancelled' }
        })
      ],
      [],
      { pendingPrompt: false }
    )
    expect(card?.caption).toBe('Stopped before it was sent')
  })

  it('words a host-restart returned card from its fact, as a rejected send', () => {
    const [card] = mobileQueuedMessageCards(
      [draft({ messageId: 'a', ...returnedAs(agentSessionFailureFact('hostRestarted')) })],
      [],
      { pendingPrompt: false }
    )
    expect(card?.caption).toBe('Orca restarted before this message was sent.')
  })

  it("keeps a provider's log-only detail off the card", () => {
    const refused = agentSessionFailureFact('providerRejected', {
      detail: { text: 'stack trace for the log', audience: 'log' }
    })
    const [card] = mobileQueuedMessageCards(
      [draft({ messageId: 'a', ...returnedAs(refused) })],
      [],
      {
        pendingPrompt: false
      }
    )
    expect(card?.caption).not.toContain('stack trace')
  })

  it("words a fact kind this build cannot place with the host's sentence", () => {
    const [card] = mobileQueuedMessageCards(
      [
        draft({
          messageId: 'a',
          state: 'returned',
          returnedReason: 'Words for a kind a newer host added.',
          returnedRejection: { kind: 'laterKind' }
        })
      ],
      [],
      { pendingPrompt: false }
    )
    expect(card?.caption).toBe('Words for a kind a newer host added.')
  })

  it("shows the host's sentence for a fact this build cannot read all of, as the desktop card", () => {
    const reason = "Claude couldn't start. Start a new chat to continue."
    // As a newer host sends it: a known code with a reason this build doesn't know.
    const newer = {
      kind: 'startFailed',
      refusal: { code: 'agent_session_conflict', details: { reason: 'newerReason' } }
    }
    const [card] = mobileQueuedMessageCards(
      [
        draft({
          messageId: 'a',
          state: 'returned',
          returnedReason: reason,
          returnedRejection: newer
        })
      ],
      [],
      { pendingPrompt: false }
    )
    expect(card?.caption).toBe(reason)
  })

  it('maps the send-failed pause marker to English and an unknown marker to a plain pause', () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'a', paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }),
        // SAFETY: a newer host's marker this build has no vocabulary for.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a marker from a newer host than this build's union.
        draft({ messageId: 'b', position: 2, paused: true, pausedReason: 'later_marker' as never })
      ],
      [],
      { pendingPrompt: false }
    )
    expect(cards.map((card) => card.caption)).toEqual([
      "Couldn't send — tap Send to retry",
      'Paused'
    ])
    // Only a failed send alerts; a plain pause is not the card's fault.
    expect(cards.map((card) => card.needsAttention)).toEqual([true, false])
  })

  it('never shows an internal rejection reason verbatim, even from a host that wrote no fact', () => {
    const [card] = mobileQueuedMessageCards(
      [
        draft({
          messageId: 'a',
          state: 'returned',
          returnedReason: DISPATCH_REJECTED_HOST_RESTARTED
        })
      ],
      [],
      { pendingPrompt: false }
    )
    expect(card?.caption).toBe('Your message was not sent.')
  })
})
