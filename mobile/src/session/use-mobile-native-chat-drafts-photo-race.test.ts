// A photo send's answer can be handled after the frame carrying its record has rendered but before
// that frame's effects run, while another bubble is pending. Its photo must still bind to its own
// drawn row; the journal's record alone retires only a photo whose row the chat hides.

import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

const OWN_ROW = agentJournalSubmissionKey('I')
const PHOTO = 'file:///photo.jpg'

const ROW: NativeChatMessage = {
  id: OWN_ROW,
  role: 'user',
  source: 'transcript',
  timestamp: null,
  blocks: [
    { type: 'text', text: 'look' },
    { type: 'image-ref', path: '/host/photo.png' }
  ]
}

const RECORD: AgentJournalSubmission = {
  clientMessageId: 'I',
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null
}

type Drafts = ReturnType<typeof useMobileNativeChatDrafts>
type Origin = NonNullable<ReturnType<Drafts['captureSendOrigin']>>

describe('a photo send answered around the frame that carries its record', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it.each([
    { earlierBubble: false, answerBeforeEffects: false },
    { earlierBubble: false, answerBeforeEffects: true },
    { earlierBubble: true, answerBeforeEffects: false },
    { earlierBubble: true, answerBeforeEffects: true }
  ])(
    'binds its photo to its own row (another bubble pending: $earlierBubble, answered before the effects: $answerBeforeEffects)',
    async ({ earlierBubble, answerBeforeEffects }) => {
      // The hook's latest result, through an object: a local the harness assigns would be narrowed to
      // null at the reads below.
      const current: { drafts?: Drafts } = {}
      let origin: Origin | null = null
      let answered = false
      const accept = (drafts: Drafts | null): void => {
        if (drafts && origin) {
          drafts.acceptSend(origin, 'look', [PHOTO], 'I')
        }
      }
      function Harness(props: {
        messages: NativeChatMessage[]
        submissions: AgentJournalSubmission[]
      }): null {
        // Declared before the hook, so it runs ahead of the hook's own effects in the same flush.
        useEffect(() => {
          if (answerBeforeEffects && !answered && props.messages.includes(ROW)) {
            answered = true
            accept(current.drafts ?? null)
          }
        })
        current.drafts = useMobileNativeChatDrafts({
          hostId: 'host',
          worktreeId: 'worktree',
          tabId: 'tab',
          sessionId: 'session',
          messages: props.messages,
          launchDraft: null,
          transcriptLoading: false,
          transcriptSettled: true,
          queuedCards: [],
          submissions: props.submissions
        })
        return null
      }
      const render = async (messages: NativeChatMessage[], submissions: AgentJournalSubmission[]) =>
        act(async () => {
          const element = createElement(Harness, { messages, submissions })
          if (renderer) {
            renderer.update(element)
          } else {
            renderer = create(element)
          }
        })

      await render([], [])
      if (earlierBubble) {
        // An earlier send still waiting for its record keeps the retirement effect running.
        const first = current.drafts?.captureSendOrigin('first')
        await act(async () => {
          if (first) {
            current.drafts?.acceptSend(first, 'first', undefined, 'P')
          }
        })
      }
      origin = current.drafts?.captureSendOrigin('look') ?? null
      // The record, written before the send is dispatched, reaches the phone first.
      await render([ROW], [RECORD])
      if (!answerBeforeEffects) {
        await act(async () => accept(current.drafts ?? null))
      }
      await render([ROW], [RECORD])

      expect(current.drafts?.pending.map((item) => item.text)).toEqual(
        earlierBubble ? ['first'] : []
      )
      expect(current.drafts?.imagePreviewsByMessageId[OWN_ROW]).toEqual([PHOTO])
    }
  )
})
