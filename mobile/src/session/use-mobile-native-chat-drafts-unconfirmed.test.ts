import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'
import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'
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

function assistantTextMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('useMobileNativeChatDrafts', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({
    tabId,
    sessionId = `session-${tabId}`,
    messages = [],
    launchDraft = null,
    chatActive = true,
    transcriptLoading = false,
    persistence,
    pendingPersistence,
    transcriptSettled = !transcriptLoading
  }: {
    tabId: string
    sessionId?: string | null
    messages?: NativeChatMessage[]
    launchDraft?: string | null
    chatActive?: boolean
    transcriptLoading?: boolean
    persistence?: HostSessionChatDraftOperations
    pendingPersistence?: HostSessionChatPendingDeliveryOperations
    transcriptSettled?: boolean
  }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId,
      messages,
      launchDraft,
      chatActive,
      transcriptLoading,
      persistence,
      pendingPersistence,
      transcriptSettled
    })
    return null
  }

  async function mount(tabId: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId }))
    })
  }

  it('registers no deadline when the transcript echo beat the ambiguous RPC rejection', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      const origin = state?.captureSendOrigin('ping')
      const onUnconfirmed = vi.fn()

      await act(async () =>
        renderer?.update(
          createElement(Harness, { tabId: 'a', messages: [userTextMessage('m1', 'ping')] })
        )
      )
      act(() => {
        if (origin) {
          state?.holdUnconfirmedSend(origin, 'ping', onUnconfirmed)
        }
      })

      expect(vi.getTimerCount()).toBe(0)
      act(() => vi.advanceTimersByTime(30_000))
      expect(onUnconfirmed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces uncertainty when no echo lands before the deadline', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      const origin = state?.captureSendOrigin('ping')
      const onUnconfirmed = vi.fn()
      act(() => {
        if (origin) {
          state?.holdUnconfirmedSend(origin, 'ping', onUnconfirmed)
        }
      })

      act(() => vi.advanceTimersByTime(19_999))
      expect(onUnconfirmed).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1))
      expect(onUnconfirmed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not confirm an unconfirmed send against an older identical turn', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      await act(async () =>
        renderer?.update(
          createElement(Harness, { tabId: 'a', messages: [userTextMessage('old', 'ping')] })
        )
      )
      act(() => state?.setComposerText('ping'))
      const origin = state?.captureSendOrigin('ping')
      const onUnconfirmed = vi.fn()
      act(() => {
        if (origin) {
          state?.holdUnconfirmedSend(origin, 'ping', onUnconfirmed)
        }
      })

      await act(async () =>
        renderer?.update(
          createElement(Harness, {
            tabId: 'a',
            messages: [userTextMessage('old', 'ping'), assistantTextMessage('other', 'working')]
          })
        )
      )
      expect(state?.composerText).toBe('ping')

      act(() => vi.advanceTimersByTime(30_000))
      expect(onUnconfirmed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not confirm an unconfirmed send when pagination prepends an older identical turn', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      const anchor = assistantTextMessage('anchor', 'working')
      await act(async () =>
        renderer?.update(createElement(Harness, { tabId: 'a', messages: [anchor] }))
      )
      act(() => state?.setComposerText('ping'))
      const origin = state?.captureSendOrigin('ping')
      const onUnconfirmed = vi.fn()
      act(() => {
        if (origin) {
          state?.holdUnconfirmedSend(origin, 'ping', onUnconfirmed)
        }
      })

      await act(async () =>
        renderer?.update(
          createElement(Harness, {
            tabId: 'a',
            messages: [userTextMessage('older', 'ping'), anchor]
          })
        )
      )
      expect(state?.composerText).toBe('ping')

      act(() => vi.advanceTimersByTime(30_000))
      expect(onUnconfirmed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires one new transcript echo per repeated unconfirmed send', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      act(() => state?.setComposerText('ping'))
      const origin = state?.captureSendOrigin('ping')
      const firstUnconfirmed = vi.fn()
      const secondUnconfirmed = vi.fn()
      act(() => {
        if (origin) {
          state?.holdUnconfirmedSend(origin, 'ping', firstUnconfirmed)
          state?.holdUnconfirmedSend(origin, 'ping', secondUnconfirmed)
        }
      })

      await act(async () =>
        renderer?.update(
          createElement(Harness, { tabId: 'a', messages: [userTextMessage('echo-1', 'ping')] })
        )
      )
      act(() => vi.advanceTimersByTime(30_000))

      expect(firstUnconfirmed).not.toHaveBeenCalled()
      expect(secondUnconfirmed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retain a deadline when an ambiguous send settles after unmount', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      const origin = state?.captureSendOrigin('ping')
      const holdUnconfirmedSend = state?.holdUnconfirmedSend
      const onUnconfirmed = vi.fn()
      act(() => renderer?.unmount())
      renderer = null

      act(() => {
        if (origin) {
          holdUnconfirmedSend?.(origin, 'ping', onUnconfirmed)
        }
      })

      expect(vi.getTimerCount()).toBe(0)
      act(() => vi.advanceTimersByTime(30_000))
      expect(onUnconfirmed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not erase newer edits when an unconfirmed send lands', async () => {
    await mount('a')
    act(() => state?.setComposerText('submitted'))
    const origin = state?.captureSendOrigin('submitted')
    act(() => {
      if (origin) {
        state?.holdUnconfirmedSend(origin, 'submitted', vi.fn())
      }
    })
    act(() => state?.setComposerText('new edit'))

    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', messages: [userTextMessage('m1', 'submitted')] })
      )
    )
    expect(state?.composerText).toBe('new edit')
  })

  it('does not confirm an old session send from an identical turn in its replacement', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      act(() => state?.setComposerText('ping'))
      const origin = state?.captureSendOrigin('ping')
      const onUnconfirmed = vi.fn()
      act(() => {
        if (origin) {
          state?.holdUnconfirmedSend(origin, 'ping', onUnconfirmed)
        }
      })

      await act(async () =>
        renderer?.update(
          createElement(Harness, {
            tabId: 'a',
            sessionId: 'replacement',
            messages: [userTextMessage('replacement-message', 'ping')]
          })
        )
      )

      expect(state?.composerText).toBe('ping')
      act(() => vi.advanceTimersByTime(30_000))
      expect(onUnconfirmed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
