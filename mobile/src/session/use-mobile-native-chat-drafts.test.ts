import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

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

  function Harness({ tabId }: { tabId: string }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId: `session-${tabId}`,
      messages: []
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
    const originA = state?.captureSendOrigin()
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

  it('does not erase newer edits when an older send settles', async () => {
    await mount('a')
    act(() => state?.setComposerText('submitted'))
    const origin = state?.captureSendOrigin()
    act(() => state?.setComposerText('new edit'))
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'submitted')
      }
    })

    expect(state?.composerText).toBe('new edit')
  })
})
