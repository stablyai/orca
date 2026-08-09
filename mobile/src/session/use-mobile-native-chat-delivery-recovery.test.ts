import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPromptSubmissionOccurrence } from '../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { mobileNativeChatPromptDigest } from './mobile-native-chat-prompt-delivery'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

describe('mobile native chat delivery recovery', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  function Harness({
    messages = [],
    promptSubmissions = []
  }: {
    messages?: NativeChatMessage[]
    promptSubmissions?: AgentPromptSubmissionOccurrence[]
  }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'tab',
      sessionId: 'session',
      messages,
      promptSubmissions
    })
    return null
  }

  async function render(props: Parameters<typeof Harness>[0] = {}): Promise<void> {
    await act(async () => {
      const element = createElement(Harness, props)
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await render()
    } finally {
      consoleSpy.mockRestore()
    }
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
    vi.useRealTimers()
  })

  it('removes an unacknowledged echo and restores it ahead of newer edits', () => {
    act(() => state?.setComposerText('ping'))
    const origin = state?.captureSendOrigin('ping')
    act(() => {
      if (origin) {
        state?.clearDraftForSend(origin, 'ping')
        state?.acceptSend(origin, 'ping')
      }
      state?.setComposerText('newer edit')
      vi.advanceTimersByTime(8_001)
    })

    expect(state?.pending).toEqual([])
    expect(state?.composerText).toBe('ping\n\nnewer edit')
    expect(state?.deliveryFailed).toBe(true)
  })

  it('keeps an acknowledged echo pending until the transcript replaces it', async () => {
    const origin = state?.captureSendOrigin('ping')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'ping')
      }
    })
    await render({
      promptSubmissions: [
        {
          streamId: 'stream',
          sequence: 1,
          digest: mobileNativeChatPromptDigest('ping'),
          receivedAt: 1
        }
      ]
    })

    act(() => vi.advanceTimersByTime(8_001))

    expect(state?.pending.map((entry) => entry.text)).toEqual(['ping'])
    expect(state?.deliveryFailed).toBe(false)
  })

  it('uses the pre-dispatch baseline when the acknowledgement beats the RPC', async () => {
    const baseline = {
      streamId: 'stream',
      sequence: 1,
      digest: mobileNativeChatPromptDigest('older'),
      receivedAt: 1
    }
    await render({ promptSubmissions: [baseline] })
    const origin = state?.captureSendOrigin('ping')
    await render({
      promptSubmissions: [
        baseline,
        {
          streamId: 'stream',
          sequence: 2,
          digest: mobileNativeChatPromptDigest('ping'),
          receivedAt: 2
        }
      ]
    })
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'ping')
      }
      vi.advanceTimersByTime(8_001)
    })

    expect(state?.pending.map((entry) => entry.text)).toEqual(['ping'])
    expect(state?.deliveryFailed).toBe(false)
  })
})
