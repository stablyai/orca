import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({
    tabId,
    sessionId = `session-${tabId}`,
    messages = []
  }: {
    tabId: string
    sessionId?: string | null
    messages?: NativeChatMessage[]
  }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId,
      messages
    })
    return null
  }

  async function mount(tabId: string): Promise<void> {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { tabId }))
      })
    } finally {
      consoleSpy.mockRestore()
    }
  }

  async function switchTo(tabId: string): Promise<void> {
    await act(async () => renderer?.update(createElement(Harness, { tabId })))
  }

  it('keeps drafts and accepted pending messages on their originating tabs', async () => {
    await mount('a')
    act(() => state?.setComposerText('from a'))
    const originA = state?.captureSendOrigin('from a')
    expect(originA).not.toBeNull()

    await switchTo('b')
    act(() => state?.setComposerText('from b'))
    act(() => {
      if (originA) {
        state?.acceptSend(originA, 'from a')
      }
    })
    expect(state?.composerText).toBe('from b')
    expect(state?.pending).toEqual([])

    await switchTo('a')
    expect(state?.composerText).toBe('')
    expect(state?.pending.map((pending) => pending.text)).toEqual(['from a'])
  })

  it('clears one pending per landed message so duplicate sends are not all dropped', async () => {
    await mount('a')
    const origin = state?.captureSendOrigin('ping')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'ping')
        state?.acceptSend(origin, 'ping')
      }
    })
    expect(state?.pending.map((pending) => pending.text)).toEqual(['ping', 'ping'])

    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', messages: [userTextMessage('m1', 'ping')] })
      )
    )
    expect(state?.pending.map((pending) => pending.text)).toEqual(['ping'])
  })

  it('keeps an image-only echo through an agent reply, clearing only when the user turn lands', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', messages: [assistantTextMessage('a1', 'hi')] })
      )
    )
    const origin = state?.captureSendOrigin('')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, '', ['file:///a.jpg'])
      }
    })
    // The echo carries the preview thumbnail and has no text to match against.
    expect(state?.pending.map((pending) => pending.images)).toEqual([['file:///a.jpg']])

    // An agent reply grows the transcript but must NOT clear the photo echo early.
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [assistantTextMessage('a1', 'hi'), assistantTextMessage('a2', 'nice photo')]
        })
      )
    )
    expect(state?.pending.map((pending) => pending.images)).toEqual([['file:///a.jpg']])

    // The user's own image echo landing (Claude records it as an
    // `[Image: source: …]` turn) clears it.
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [
            assistantTextMessage('a1', 'hi'),
            assistantTextMessage('a2', 'nice photo'),
            userTextMessage('u1', '[Image: source: /tmp/a.png]')
          ]
        })
      )
    )
    expect(state?.pending).toEqual([])
  })

  it("keeps an image-only echo when an unrelated text send's echo lands", async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', messages: [assistantTextMessage('a1', 'hi')] })
      )
    )
    const textOrigin = state?.captureSendOrigin('ping')
    const imageOrigin = state?.captureSendOrigin('')
    act(() => {
      if (textOrigin && imageOrigin) {
        state?.acceptSend(textOrigin, 'ping')
        state?.acceptSend(imageOrigin, '', ['file:///a.jpg'])
      }
    })
    expect(state?.pending).toHaveLength(2)

    // The text echo lands first: it must clear only the text pending — a user
    // turn that is not an image echo cannot reconcile the photo.
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [assistantTextMessage('a1', 'hi'), userTextMessage('u1', 'ping')]
        })
      )
    )
    expect(state?.pending.map((pending) => pending.images)).toEqual([['file:///a.jpg']])

    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [
            assistantTextMessage('a1', 'hi'),
            userTextMessage('u1', 'ping'),
            userTextMessage('u2', '[Image: source: /tmp/a.png]')
          ]
        })
      )
    )
    expect(state?.pending).toEqual([])
  })

  it('reconciles a captioned image echo that carries the [Image #N] marker', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', messages: [assistantTextMessage('a1', 'hi')] })
      )
    )
    const origin = state?.captureSendOrigin('look at this')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'look at this', ['file:///a.jpg'])
      }
    })
    expect(state?.pending).toHaveLength(1)

    // Claude echoes a captioned image send as two turns: the source marker and
    // the caption prefixed with `[Image #1] ` — the pending must still match.
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [
            assistantTextMessage('a1', 'hi'),
            userTextMessage('u1', '[Image: source: /tmp/a.png]'),
            userTextMessage('u2', '[Image #1] look at this')
          ]
        })
      )
    )
    expect(state?.pending).toEqual([])
  })

  it('does not reconcile a repeated send against an older identical turn', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', messages: [userTextMessage('old', 'ping')] })
      )
    )
    const origin = state?.captureSendOrigin('ping')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'ping')
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
    expect(state?.pending.map((pending) => pending.text)).toEqual(['ping'])

    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [
            userTextMessage('old', 'ping'),
            assistantTextMessage('other', 'working'),
            userTextMessage('new', 'ping')
          ]
        })
      )
    )
    expect(state?.pending).toEqual([])
  })

  it('does not erase newer edits when an older send settles', async () => {
    await mount('a')
    act(() => state?.setComposerText('submitted'))
    const origin = state?.captureSendOrigin('submitted')
    act(() => state?.setComposerText('new edit'))
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'submitted')
      }
    })

    expect(state?.composerText).toBe('new edit')
  })

  it('clears the draft when an unconfirmed send lands in the transcript', async () => {
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
      expect(state?.composerText).toBe('ping')

      await act(async () =>
        renderer?.update(
          createElement(Harness, { tabId: 'a', messages: [userTextMessage('m1', 'ping')] })
        )
      )
      expect(state?.composerText).toBe('')

      act(() => vi.advanceTimersByTime(30_000))
      expect(onUnconfirmed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles an image-only unconfirmed send against the next user turn (no false warning)', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      await act(async () =>
        renderer?.update(
          createElement(Harness, { tabId: 'a', messages: [assistantTextMessage('a1', 'hi')] })
        )
      )
      // Image-only send: empty text, so it can only reconcile against a new user turn.
      const origin = state?.captureSendOrigin('')
      const onUnconfirmed = vi.fn()
      act(() => {
        if (origin) {
          state?.holdUnconfirmedSend(origin, '', onUnconfirmed)
        }
      })

      // An agent reply must not confirm it...
      await act(async () =>
        renderer?.update(
          createElement(Harness, {
            tabId: 'a',
            messages: [assistantTextMessage('a1', 'hi'), assistantTextMessage('a2', 'ok')]
          })
        )
      )
      // ...but the user's own turn landing does, so the deadline never warns.
      await act(async () =>
        renderer?.update(
          createElement(Harness, {
            tabId: 'a',
            messages: [
              assistantTextMessage('a1', 'hi'),
              assistantTextMessage('a2', 'ok'),
              userTextMessage('u1', '')
            ]
          })
        )
      )
      act(() => vi.advanceTimersByTime(30_000))
      expect(onUnconfirmed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears image-only echoes one per landed user turn, not all at once', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', messages: [assistantTextMessage('a1', 'hi')] })
      )
    )
    const origin = state?.captureSendOrigin('')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, '', ['file:///a.jpg'])
        state?.acceptSend(origin, '', ['file:///b.jpg'])
      }
    })
    expect(state?.pending).toHaveLength(2)

    // Only one image echo has landed — exactly one photo reconciles.
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [
            assistantTextMessage('a1', 'hi'),
            userTextMessage('u1', '[Image: source: /tmp/a.png]')
          ]
        })
      )
    )
    expect(state?.pending.map((pending) => pending.images)).toEqual([['file:///b.jpg']])
  })

  it('clears immediately when the transcript echo beat the ambiguous RPC rejection', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      act(() => state?.setComposerText('ping'))
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

      expect(state?.composerText).toBe('')
      expect(vi.getTimerCount()).toBe(0)
      act(() => vi.advanceTimersByTime(30_000))
      expect(onUnconfirmed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces uncertainty and keeps the draft when no echo lands before the deadline', async () => {
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

      act(() => vi.advanceTimersByTime(19_999))
      expect(onUnconfirmed).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1))
      expect(onUnconfirmed).toHaveBeenCalledTimes(1)
      expect(state?.composerText).toBe('ping')
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

  it('accepts and clears the first send before a provider session id exists', async () => {
    await mount('a')
    await act(async () => renderer?.update(createElement(Harness, { tabId: 'a', sessionId: null })))
    act(() => state?.setComposerText('start the session'))

    const origin = state?.captureSendOrigin('start the session')
    expect(origin).toMatchObject({ pendingKey: null })
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'start the session')
      }
    })

    expect(state?.composerText).toBe('')
    expect(state?.pending).toEqual([])
  })
})
