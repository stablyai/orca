import { describe, expect, it } from 'vitest'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { agentSessionFailureFact } from '../../../src/shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session/failures/agent-session-failure-words'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage
} from '../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import { queuedMessagesQueuePause } from '../../../src/shared/agent-session/view/structured-agent-session-queued-cards'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { mobileQueuedMessageCards } from './mobile-structured-queued-message-cards'

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
  it('names command sources alongside agents in English and translated queued cards', async () => {
    const source = {
      kind: 'agent' as const,
      senders: [
        {
          name: null,
          party: { address: 'ci-notifier', terminalHandle: 'ci-notifier', orcaSessionId: null }
        },
        {
          name: 'Coder',
          party: { address: 'term_coder', terminalHandle: 'term_coder', orcaSessionId: null }
        }
      ],
      orchestration: null
    }
    const queued = {
      messageId: 'command-mail',
      position: 1,
      state: 'waiting' as const,
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Background command completed' }],
        from: source
      }
    }
    const sourceOnly = {
      ...queued,
      messageId: 'command-only-mail',
      body: { ...queued.body, from: { ...source, senders: source.senders.slice(0, 1) } }
    }
    const terminal = {
      name: null,
      party: { address: 'term_plain', terminalHandle: 'term_plain', orcaSessionId: null }
    }
    const legacy = {
      ...sourceOnly,
      messageId: 'legacy',
      body: { ...sourceOnly.body, from: { ...source, senders: [terminal] } }
    }
    const report = {
      ...legacy,
      messageId: 'report',
      body: {
        ...legacy.body,
        from: {
          ...legacy.body.from,
          orchestration: {
            message: 'mail-notice' as const,
            mailbox: 'run:r',
            dispatchId: null,
            messages: [{ messageId: 'm', runId: 'r', from: 'term_plain' }]
          }
        }
      }
    }
    const terminalCards = mobileQueuedMessageCards([legacy, report], [])
    expect(terminalCards.map((card) => card.attribution)).toEqual(['From Terminal', 'Terminal'])
    expect(terminalCards.map((card) => [card.messageId, card.line, card.caption])).toEqual([
      ['legacy', 'Background command completed', null],
      ['report', 'Background command completed', null]
    ])
    expect(
      mobileQueuedMessageCards([sourceOnly, queued], []).map((card) => card.attribution)
    ).toEqual(['From ci-notifier', 'From ci-notifier, Coder'])
    try {
      await activateMobileUiLocale('fr')
      expect(
        mobileQueuedMessageCards([legacy, report], []).map((card) => card.attribution)
      ).toEqual(['De la part de Terminal', 'Terminal'])
      expect(
        mobileQueuedMessageCards([sourceOnly, queued], []).map((card) => card.attribution)
      ).toEqual(['De la part de ci-notifier', 'De la part de ci-notifier, Coder'])
    } finally {
      await activateMobileUiLocale('en')
    }
  })

  it('finds something for Resume to send only in a waiting card with no hold, ahead of a returned one', () => {
    const resumable = (drafts: AgentSessionQueuedMessage[]) =>
      queuedMessagesQueuePause(mobileQueuedMessageCards(drafts, []), { reason: 'stopped' }) !== null
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
  })

  it('hides a waiting card once its hand-off arrived, never a returned one', () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'returned', ...returnedAs(agentSessionFailureFact('hostRestarted')) }),
        draft({ messageId: 'drained', position: 2 }),
        draft({ messageId: 'waiting', position: 3 })
      ],
      [handOff('returned', 'rejected'), handOff('drained', 'pending')]
    )
    expect(cards.map((card) => card.messageId)).toEqual(['returned', 'waiting'])
    expect(cards[1]?.caption).toBe('Waiting — a message ahead needs attention')
  })

  it('shows a draft a Stop requeued beside its rejected hand-off', () => {
    // Rejected hand-offs stay hidden in history; the requeued card is the only reachable copy of their text.
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'requeued' }),
        draft({ messageId: 'sending', position: 2 }),
        draft({ messageId: 'sent', position: 3 })
      ],
      [handOff('requeued', 'rejected'), handOff('sending', 'pending'), handOff('sent', 'accepted')]
    )
    expect(cards.map((card) => card.messageId)).toEqual(['requeued'])
  })
})

function handOff(
  queuedMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId: `${queuedMessageId}-handoff`,
    queuedMessageId,
    dispatchState,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}
