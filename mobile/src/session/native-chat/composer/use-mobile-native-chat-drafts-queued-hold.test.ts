import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { resetMobileNativeChatDraftStoreForTests } from './mobile-native-chat-draft-store'

describe('useMobileNativeChatDrafts with queued cards', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatDrafts> | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    resetMobileNativeChatDraftStoreForTests()
    renderer = null
    state = null
  })

  function Harness(): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId: 'session-a',
      messages: [],
      launchDraft: null,
      transcriptLoading: false,
      transcriptSettled: true
    })
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
