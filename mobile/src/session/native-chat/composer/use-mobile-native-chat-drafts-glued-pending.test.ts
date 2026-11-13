import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  closeMobileNativeChatTabDraft,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

import { loadMobileNativeChatDrafts } from './mobile-native-chat-draft-persistence'

vi.mock('@react-native-async-storage/async-storage', async () => {
  const { createInMemoryAsyncStorage } =
    await import('../../../test-support/in-memory-async-storage')
  return { default: createInMemoryAsyncStorage() }
})

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

function userTextMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('useMobileNativeChatDrafts glued pending sends', () => {
  let renderer: TestRenderer | null = null
  let state: DraftState | null = null

  afterEach(async () => {
    act(() => renderer?.unmount())
    await loadMobileNativeChatDrafts('host', 'worktree')
    closeMobileNativeChatTabDraft('host\0worktree\0tab')
    await loadMobileNativeChatDrafts('host', 'worktree')
    renderer = null
    state = null
  })

  function Harness({
    messages,
    transcriptLoading = false,
    transcriptSettled = !transcriptLoading,
    sessionId = 'session'
  }: {
    messages: NativeChatMessage[]
    transcriptLoading?: boolean
    transcriptSettled?: boolean
    sessionId?: string | null
  }): null {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'tab',
      sessionId,
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
    transcriptSettled = !transcriptLoading,
    sessionId: string | null = 'session'
  ): Promise<void> {
    await act(async () =>
      renderer?.update(
        createElement(Harness, { messages, transcriptLoading, transcriptSettled, sessionId })
      )
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
  it('preserves the full waiting-image union across repeated session rebinding', async () => {
    await mount([])
    act(() => {
      for (let index = 0; index < 8; index++) {
        const text = `phone-${index}`
        const origin = state!.captureSendOrigin(text)
        state!.acceptSend(origin!, text)
      }
    })
    const captions = Array.from({ length: 8 }, (_, index) => `phone-${index}`)
    for (const batch of [1, 8]) {
      await update([], false, true, null)
      act(() => {
        for (let index = 0; index < batch; index++) {
          const next = captions.length
          const text = `photo-${next}`
          const origin = state!.captureSendOrigin(text)
          state!.acceptSend(origin!, text, [`file:///photo-${next}.png`])
          captions.push(text)
        }
      })
      await update([])
      expect(state?.pending.map((entry) => entry.text)).toEqual(captions)
    }
    expect(state?.pending).toHaveLength(17)
    expect(new Set(state?.pending.map((entry) => entry.id)).size).toBe(17)
    const messages = captions.flatMap((text, index) =>
      index < 8
        ? [userTextMessage(`prompt-${index}`, text)]
        : [
            userTextMessage(`source-${index}`, `[Image: source: /tmp/photo-${index}.png]`),
            userTextMessage(`prompt-${index}`, `[Image #1] ${text}`)
          ]
    )
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          messages: [...messages, assistantTurn('reply', 'finished', 10000)]
        })
      )
    )
    expect(state?.pending).toEqual([])
    expect(state?.imagePreviewsByMessageId).toEqual(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `prompt-${index + 8}`,
          [`file:///photo-${index + 8}.png`]
        ])
      )
    )
  })
})
