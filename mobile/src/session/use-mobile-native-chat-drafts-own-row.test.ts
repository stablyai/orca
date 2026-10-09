// A structured send's bubble and its unconfirmed hold are settled by the journal's record of the
// send's own id (or of its card's hand-off), drawn or not, and never by another row with its text.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type QueuedCard = { messageId: string; text: string }

function user(clientMessageId: string, text: string, unsent = false): NativeChatMessage {
  return {
    id: agentJournalSubmissionKey(clientMessageId),
    role: 'user',
    source: 'transcript',
    timestamp: null,
    blocks: [{ type: 'text', text }],
    ...(unsent ? { unsent: true as const } : {})
  }
}

function recorded(
  clientMessageId: string,
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: `body:${clientMessageId}`,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1,
    ...patch
  }
}

const ANSWER: NativeChatMessage = {
  id: 'answer',
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  blocks: [{ type: 'text', text: 'Hi' }]
}

describe('useMobileNativeChatDrafts with a structured send id', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatDrafts> | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
    vi.useRealTimers()
  })

  function Harness(props: {
    messages: NativeChatMessage[]
    queuedCards: QueuedCard[]
    submissions: AgentJournalSubmission[]
  }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId: 'session-a',
      messages: props.messages,
      launchDraft: null,
      transcriptLoading: false,
      transcriptSettled: true,
      queuedCards: props.queuedCards,
      submissions: props.submissions
    })
    return null
  }

  async function render(
    messages: NativeChatMessage[],
    queuedCards: QueuedCard[] = [],
    submissions: AgentJournalSubmission[] = SUBMITTED
  ) {
    await act(async () => {
      const element = createElement(Harness, { messages, queuedCards, submissions })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  function origin(text: string) {
    const captured = state?.captureSendOrigin(text)
    if (!captured) {
      throw new Error('no send origin')
    }
    return captured
  }

  /** Holds a lost send; the returned call runs out its deadline and hands back the warning spy. */
  function holdLostSend(text: string, clientMessageId: string): () => ReturnType<typeof vi.fn> {
    const onUnconfirmed = vi.fn()
    const captured = origin(text)
    act(() => state?.holdUnconfirmedSend(captured, text, onUnconfirmed, clientMessageId))
    return () => {
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      return onUnconfirmed
    }
  }

  const BEFORE = [ANSWER, user('m1', 'fix the test', true)]
  const SUBMITTED = [recorded('m1', { dispatchState: 'rejected' })]

  it('retires the bubble on its own row, even once the not-sent original is gone', async () => {
    await render(BEFORE)
    const captured = origin('fix the test')
    act(() => state?.acceptSend(captured, 'fix the test', undefined, 'm2'))
    expect(state?.pending.map((item) => item.text)).toEqual(['fix the test'])
    // Once the resend is recorded the projection drops the not-sent original it copies.
    await render([ANSWER, user('m2', 'fix the test')], [], [...SUBMITTED, recorded('m2')])
    expect(state?.pending).toEqual([])
  })

  it('stays quiet when its own row arrives already shown as not sent', async () => {
    await render(BEFORE)
    const settle = holdLostSend('later', 'm2')
    await render(
      [...BEFORE, user('m2', 'later', true)],
      [],
      [...SUBMITTED, recorded('m2', { dispatchState: 'rejected' })]
    )
    expect(settle()).not.toHaveBeenCalled()
  })

  it('retires the bubble on its record while the host has not answered it yet', async () => {
    await render(BEFORE)
    act(() => state?.acceptSend(origin('later'), 'later', undefined, 'm2'))
    await render(
      [...BEFORE, user('m2', 'later')],
      [],
      [...SUBMITTED, recorded('m2', { dispatchState: 'pending', resolvedAt: null })]
    )
    expect(state?.pending).toEqual([])
  })

  it('still warns when only another row with its text is there', async () => {
    await render(BEFORE)
    const settle = holdLostSend('fix the test', 'm2')
    await render([...BEFORE, user('m3', 'fix the test')], [], [...SUBMITTED, recorded('m3')])
    expect(settle()).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the host holds it as its own card, not one with the same text', async () => {
    await render(BEFORE, [{ messageId: 'other', text: 'queued words' }])
    const settle = holdLostSend('queued words', 'm2')
    await render(BEFORE, [
      { messageId: 'other', text: 'queued words' },
      { messageId: 'm2', text: 'queued words' }
    ])
    expect(settle()).not.toHaveBeenCalled()
  })

  // Its card went out under a fresh id before the phone saw the card, so no row carries its id.
  it('stays quiet when its card was handed off before the phone saw it', async () => {
    await render(BEFORE)
    const settle = holdLostSend('queued words', 'm2')
    await render(
      [...BEFORE, user('fresh', 'queued words')],
      [],
      [...SUBMITTED, recorded('fresh', { queuedMessageId: 'm2' })]
    )
    expect(settle()).not.toHaveBeenCalled()
  })

  it('still warns when a new card has its text but is not its own', async () => {
    await render(BEFORE)
    const settle = holdLostSend('queued words', 'm2')
    await render(BEFORE, [{ messageId: 'another-phone', text: 'queued words' }])
    expect(settle()).toHaveBeenCalledTimes(1)
  })
})
