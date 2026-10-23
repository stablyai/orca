import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { resetMobileNativeChatDraftStoreForTests } from './mobile-native-chat-draft-store'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

describe('mobile native-chat draft store', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    resetMobileNativeChatDraftStoreForTests()
    renderer = null
    state = null
  })

  function Harness({ tabId }: { tabId: string }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId: `session-${tabId}`,
      messages: [],
      transcriptSettled: true
    })
    return null
  }

  async function mount(tabId: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId }))
    })
  }

  it('clears the composer at send time, before the RPC settles', async () => {
    await mount('a')
    act(() => state?.setComposerText('ping'))
    const origin = state?.captureSendOrigin('ping')
    act(() => {
      if (origin) {
        state?.clearDraftForSend(origin, 'ping')
      }
    })
    expect(state?.composerText).toBe('')
  })

  it('keeps a typed draft after the chat screen unmounts and remounts', async () => {
    await mount('a')
    act(() => state?.setComposerText('half-written prompt'))
    act(() => renderer?.unmount())

    await mount('a')
    expect(state?.composerText).toBe('half-written prompt')
  })

  it('keeps each tab its own draft across a remount', async () => {
    await mount('a')
    act(() => state?.setComposerText('for a'))
    act(() => renderer?.unmount())

    await mount('b')
    expect(state?.composerText).toBe('')
    act(() => state?.setComposerText('for b'))
    act(() => renderer?.unmount())

    await mount('a')
    expect(state?.composerText).toBe('for a')
  })

  it('lets an old send clear its unchanged scope after another tab was edited', async () => {
    await mount('a')
    act(() => state?.setComposerText('for a'))
    const origin = state?.captureSendOrigin('for a')
    const oldClear = state?.clearDraftForSend
    act(() => renderer?.unmount())
    await mount('b')
    act(() => state?.setComposerText('for b'))
    act(() => {
      if (origin) {
        oldClear?.(origin, 'for a')
      }
    })
    expect(state?.composerText).toBe('for b')
    act(() => renderer?.unmount())
    await mount('a')
    expect(state?.composerText).toBe('')
  })
})
