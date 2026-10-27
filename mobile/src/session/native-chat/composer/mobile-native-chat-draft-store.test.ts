import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts> & { composerText: string }

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
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId: `session-${tabId}`,
      messages: [],
      transcriptSettled: true
    })
    state = { ...drafts, composerText: useMobileNativeChatDraft(drafts.draftKey) }
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

  it('redraws only the draft subscriber per keystroke, not the screen that owns the drafts', async () => {
    let screenRenders = 0
    let shown = ''
    let owner: ReturnType<typeof useMobileNativeChatDrafts> | null = null
    function Composer({ draftKey }: { draftKey: string | null }): null {
      shown = useMobileNativeChatDraft(draftKey)
      return null
    }
    const messages: NativeChatMessage[] = []
    function Screen(): ReturnType<typeof createElement> {
      screenRenders += 1
      owner = useMobileNativeChatDrafts({
        hostId: 'host',
        worktreeId: 'worktree',
        tabId: 'a',
        sessionId: 'session-a',
        messages,
        transcriptSettled: true
      })
      return createElement(Composer, { draftKey: owner.draftKey })
    }
    await act(async () => {
      renderer = create(createElement(Screen))
    })
    const rendersBeforeTyping = screenRenders

    act(() => owner?.setComposerText('typed'))

    expect(shown).toBe('typed')
    expect(screenRenders).toBe(rendersBeforeTyping)
  })
})
