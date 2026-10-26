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

  function currentState(): DraftState {
    if (!state) {
      throw new Error('chat draft harness is not mounted')
    }
    return state
  }

  function sendOrigin(text: string): NonNullable<ReturnType<DraftState['captureSendOrigin']>> {
    const origin = currentState().captureSendOrigin(text)
    if (!origin) {
      throw new Error('chat draft has no send origin')
    }
    return origin
  }

  async function mount(tabId: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId }))
    })
  }

  it('clears unchanged drafts and preserves newer edits with the same text', async () => {
    await mount('a')
    act(() => currentState().setComposerText('ping'))
    const origin = sendOrigin('ping')
    act(() => {
      currentState().clearDraftForSend(origin, 'ping')
    })
    expect(currentState().composerText).toBe('')

    act(() => currentState().setComposerText('ping'))
    const editedOrigin = sendOrigin('ping')
    act(() => currentState().setComposerText('ping'))
    act(() => currentState().clearDraftForSend(editedOrigin, 'ping'))
    expect(currentState().composerText).toBe('ping')
  })

  it('keeps a typed draft after the chat screen unmounts and remounts', async () => {
    await mount('a')
    act(() => currentState().setComposerText('half-written prompt'))
    act(() => renderer?.unmount())

    await mount('a')
    expect(currentState().composerText).toBe('half-written prompt')
  })

  it('keeps each tab its own draft across a remount', async () => {
    await mount('a')
    act(() => currentState().setComposerText('for a'))
    act(() => renderer?.unmount())

    await mount('b')
    expect(currentState().composerText).toBe('')
    act(() => currentState().setComposerText('for b'))
    act(() => renderer?.unmount())

    await mount('a')
    expect(currentState().composerText).toBe('for a')
  })

  it('lets an old send clear its unchanged scope after another tab was edited', async () => {
    await mount('a')
    act(() => currentState().setComposerText('for a'))
    const origin = sendOrigin('for a')
    const oldClear = currentState().clearDraftForSend
    act(() => renderer?.unmount())
    await mount('b')
    act(() => currentState().setComposerText('for b'))
    act(() => {
      oldClear(origin, 'for a')
    })
    expect(currentState().composerText).toBe('for b')
    act(() => renderer?.unmount())
    await mount('a')
    expect(currentState().composerText).toBe('')
  })
})
