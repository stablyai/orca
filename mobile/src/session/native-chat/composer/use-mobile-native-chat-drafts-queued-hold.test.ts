import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  closeMobileNativeChatTabDraft,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

import { loadMobileNativeChatDrafts } from './mobile-native-chat-draft-persistence'

vi.mock('@react-native-async-storage/async-storage', async () => {
  const { createInMemoryAsyncStorage } =
    await import('../../../test-support/in-memory-async-storage')
  return { default: createInMemoryAsyncStorage() }
})

describe('useMobileNativeChatDrafts with queued cards', () => {
  let renderer: ReactTestRenderer | null = null
  let state: (ReturnType<typeof useMobileNativeChatDrafts> & { composerText: string }) | null = null

  afterEach(async () => {
    act(() => renderer?.unmount())
    await loadMobileNativeChatDrafts('host', 'worktree')
    closeMobileNativeChatTabDraft('host\0worktree\0a')
    await loadMobileNativeChatDrafts('host', 'worktree')
    renderer = null
    state = null
  })

  function Harness(): null {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId: 'session-a',
      messages: [],
      launchDraft: null,
      transcriptLoading: false,
      transcriptSettled: true
    })
    state = { ...drafts, composerText: useMobileNativeChatDraft(drafts.draftKey) }
    return null
  }

  async function render(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
  }

  it("reports whether a queued card's Edit copy landed, so Edit never deletes text it did not keep", async () => {
    await render()
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
})
