import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts> & { composerText: string }

function userTextMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('useMobileNativeChatDrafts launch draft', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    resetMobileNativeChatDraftStoreForTests()
    renderer = null
    state = null
  })

  function Harness({
    tabId,
    sessionId = `session-${tabId}`,
    messages = [],
    launchDraft = null,
    launchDraftCreatedAt = null,
    chatActive = true,
    transcriptLoading = false,
    transcriptSettled = !transcriptLoading
  }: {
    tabId: string
    sessionId?: string | null
    messages?: NativeChatMessage[]
    launchDraft?: string | null
    launchDraftCreatedAt?: number | null
    chatActive?: boolean
    transcriptLoading?: boolean
    transcriptSettled?: boolean
  }): null {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId,
      messages,
      launchDraft,
      launchDraftCreatedAt,
      chatActive,
      transcriptLoading,
      transcriptSettled
    })
    state = { ...drafts, composerText: useMobileNativeChatDraft(drafts.draftKey) }
    return null
  }

  async function mount(tabId: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId }))
    })
  }

  it('does not resurrect a cleared prefill after the chat screen remounts', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId: 'a', launchDraft: 'issue link' }))
    })
    expect(state?.composerText).toBe('issue link')
    act(() => state?.setComposerText(''))
    act(() => renderer?.unmount())

    await act(async () => {
      renderer = create(createElement(Harness, { tabId: 'a', launchDraft: 'issue link' }))
    })
    expect(state?.composerText).toBe('')
  })

  it('does not retire an adopted prefill from the transcript it is still showing', async () => {
    const carriedOver = [userTextMessage('m1', 'sent on a')]
    await mount('b')
    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'b', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('issue link')

    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', messages: carriedOver }))
    )
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'b',
          messages: carriedOver,
          launchDraft: 'issue link',
          transcriptLoading: true
        })
      )
    )
    expect(state?.composerText).toBe('issue link')

    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'b', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('issue link')
  })
})
