import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts> & { composerText: string }
type TestRenderer = {
  unmount(): void
  update(element: ReturnType<typeof createElement>): void
}

function assistantTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function imageTurn(id: string, path: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: `[Image: source: ${path}]` }],
    timestamp,
    source: 'transcript'
  }
}

describe('useMobileNativeChatDrafts glued pending sends', () => {
  let renderer: TestRenderer | null = null
  let state: DraftState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    resetMobileNativeChatDraftStoreForTests()
    renderer = null
    state = null
  })

  function Harness({
    messages,
    transcriptLoading = false,
    transcriptSettled = !transcriptLoading
  }: {
    messages: NativeChatMessage[]
    transcriptLoading?: boolean
    transcriptSettled?: boolean
  }): null {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'tab',
      sessionId: 'session',
      messages,
      transcriptLoading,
      transcriptSettled
    })
    state = { ...drafts, composerText: useMobileNativeChatDraft(drafts.draftKey) }
    return null
  }

  async function mount(
    messages: NativeChatMessage[],
    transcriptLoading = false,
    transcriptSettled = !transcriptLoading
  ): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { messages, transcriptLoading, transcriptSettled }))
    })
  }

  async function update(
    messages: NativeChatMessage[],
    transcriptLoading = false,
    transcriptSettled = !transcriptLoading
  ): Promise<void> {
    await act(async () =>
      renderer?.update(createElement(Harness, { messages, transcriptLoading, transcriptSettled }))
    )
  }

  // Between the older history rows and the rows that land after a send, on the host's clock.
  const SENT_AT = 3000

  // Hydrating rows give no boundary, so these sends match only rows newer than their send time.
  describe('sends issued while the transcript is still hydrating', () => {
    // An image retires only by preview binding; excluding its own echo would strand both the photo and later glued sends.
    it('retires a photo whose image echo arrives with the read', async () => {
      await mount([], true)
      act(() => {
        const origin = state?.captureSendOrigin('', SENT_AT)
        if (origin) {
          state?.acceptSend(origin, '', ['file:///new.png'])
        }
      })

      const withEcho = [assistantTurn('m1', 'ready', 1000), imageTurn('m2', '/tmp/new.png', 5000)]
      await update(withEcho)
      expect(state?.pending).toEqual([])
      expect(state?.imagePreviewsByMessageId).toEqual({ m2: ['file:///new.png'] })
    })
  })

  // Failed-read emptiness is unknown history, not an empty conversation; old rows must not claim sends against it.
})
