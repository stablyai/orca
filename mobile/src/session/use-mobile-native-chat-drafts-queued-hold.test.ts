// An ack-lost send the host took as a queued draft shows as a card, not in the
// transcript, until the turn ends — so the unconfirmed hold must count the card
// as delivery, or the user is told to "check chat" about a message on screen.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type QueuedCard = { messageId: string; text: string }

describe('useMobileNativeChatDrafts unconfirmed hold with queued cards', () => {
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

  function Harness({ queuedCards }: { queuedCards: QueuedCard[] }): null {
    state = useMobileNativeChatDrafts({
      submissions: [],
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId: 'session-a',
      messages: [],
      launchDraft: null,
      transcriptLoading: false,
      transcriptSettled: true,
      queuedCards
    })
    return null
  }

  async function render(queuedCards: QueuedCard[]): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Harness, { queuedCards }))
      } else {
        renderer = create(createElement(Harness, { queuedCards }))
      }
    })
  }

  /** Holds a lost send; the returned call runs out its deadline and hands back the warning spy. */
  function holdLostSend(text: string): () => ReturnType<typeof vi.fn> {
    const onUnconfirmed = vi.fn()
    const origin = state?.captureSendOrigin(text)
    if (!origin) {
      throw new Error('no send origin')
    }
    act(() => state?.holdUnconfirmedSend(origin, text, onUnconfirmed))
    return () => {
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      return onUnconfirmed
    }
  }

  it("reports whether a queued card's Edit copy landed, so Edit never deletes text it did not keep", async () => {
    await render([])
    let copied: boolean | undefined
    act(() => {
      copied = state?.appendComposerText('')
    })
    expect(copied).toBe(false)
    act(() => {
      copied = state?.appendComposerText('edited text')
    })
    expect(copied).toBe(true)
    expect(state?.composerText).toBe('edited text')
  })

  it('stays quiet when the lost send appears as a queued card', async () => {
    await render([])
    const settle = holdLostSend('after this turn')
    await render([{ messageId: 'draft-1', text: 'after this turn' }])
    expect(settle()).not.toHaveBeenCalled()
  })

  it('stays quiet when the card was published before the lost answer returned', async () => {
    await render([])
    const origin = state?.captureSendOrigin('raced')
    await render([{ messageId: 'draft-1', text: 'raced' }])
    const onUnconfirmed = vi.fn()
    act(() => {
      if (origin) {
        state?.holdUnconfirmedSend(origin, 'raced', onUnconfirmed)
      }
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(onUnconfirmed).not.toHaveBeenCalled()
  })

  it('does not confirm against an identical card already on screen at send time', async () => {
    await render([{ messageId: 'earlier', text: 'same words' }])
    const settle = holdLostSend('same words')
    await render([
      { messageId: 'earlier', text: 'same words' },
      { messageId: 'x', text: 'other' }
    ])
    expect(settle()).toHaveBeenCalledTimes(1)
  })
})
