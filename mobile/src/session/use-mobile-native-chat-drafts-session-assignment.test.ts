import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

function userTextMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('useMobileNativeChatDrafts session assignment', () => {
  it('preserves first-send images through transcript replacement', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    let renderer: ReactTestRenderer | null = null
    let state: DraftState | null = null
    function Harness({
      sessionId,
      messages = []
    }: {
      sessionId: string | null
      messages?: NativeChatMessage[]
    }): null {
      state = useMobileNativeChatDrafts({
        hostId: 'host',
        worktreeId: 'worktree',
        tabId: 'a',
        sessionId,
        messages,
        launchDraft: null,
        chatActive: true,
        transcriptLoading: false,
        transcriptSettled: true
      })
      return null
    }
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { sessionId: null }))
      })
    } finally {
      consoleSpy.mockRestore()
    }

    try {
      const images = ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg']
      act(() => state?.setComposerText('look'))
      const origin = state?.captureSendOrigin('look')
      expect(origin).toMatchObject({ pendingKey: null })
      act(() => {
        if (origin) {
          state?.clearDraftForSend(origin, 'look')
          state?.acceptSend(origin, 'look', images)
        }
      })
      expect(state?.composerText).toBe('')
      expect(state?.pending.map((pending) => pending.images)).toEqual([images])

      await act(async () => renderer?.update(createElement(Harness, { sessionId: 'assigned' })))
      expect(state?.pending.map((pending) => pending.images)).toEqual([images])

      const sourceMessages = [
        userTextMessage('source-1', '[Image: source: /tmp/a.png]'),
        userTextMessage('source-2', '[Image: source: /tmp/b.png]'),
        userTextMessage('source-3', '[Image: source: /tmp/c.png]')
      ]
      await act(async () =>
        renderer?.update(
          createElement(Harness, { sessionId: 'assigned', messages: sourceMessages })
        )
      )
      expect(state?.pending.map((pending) => pending.images)).toEqual([images])

      await act(async () =>
        renderer?.update(
          createElement(Harness, {
            sessionId: 'assigned',
            messages: [
              ...sourceMessages,
              userTextMessage('prompt', '[Image #1] [Image #2] [Image #3] look')
            ]
          })
        )
      )
      expect(state?.pending).toEqual([])
      expect(state?.imagePreviewsByMessageId).toEqual({ prompt: images })
    } finally {
      act(() => renderer?.unmount())
    }
  })
})
