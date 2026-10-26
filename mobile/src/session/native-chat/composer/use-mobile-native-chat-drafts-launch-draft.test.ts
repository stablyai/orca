import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../../../src/shared/structured-agent-session-message-projection'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { resetMobileNativeChatDraftStoreForTests } from './mobile-native-chat-draft-store'

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
    state = useMobileNativeChatDrafts({
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
    return null
  }

  async function mount(tabId: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId }))
    })
  }

  it('prefills the composer from a host launch draft exactly once', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', launchDraft: 'https://github.com/o/r/issues/12' })
      )
    )
    expect(state?.composerText).toBe('https://github.com/o/r/issues/12')

    act(() => state?.setComposerText(''))
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', launchDraft: 'https://github.com/o/r/issues/12' })
      )
    )
    expect(state?.composerText).toBe('')
  })

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

  it('captures the generation paired with the adopted text', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          launchDraft: 'issue link',
          launchDraftCreatedAt: 7
        })
      )
    )

    expect(state?.readSeededLaunchDraftSeed()).toEqual({ text: 'issue link', createdAt: 7 })
  })

  it('does not overwrite typed composer text with a launch draft', async () => {
    await mount('a')
    act(() => state?.setComposerText('typed first'))
    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('typed first')
  })

  it('declines a launch draft when the transcript already has a user turn', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [userTextMessage('m1', 'already sent')],
          launchDraft: 'issue link'
        })
      )
    )
    expect(state?.composerText).toBe('')
  })

  it("declines a launch draft once the phone's own accepted send is drawn", async () => {
    await mount('a')
    const drawn = projectStructuredAgentSessionMessages(
      [],
      [
        {
          clientMessageId: 'sent',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
          queuedAt: 1
        }
      ],
      []
    )
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', messages: drawn, launchDraft: 'issue link' })
      )
    )
    expect(state?.composerText).toBe('')
  })

  it('clears an untouched prefill once a user turn lands, keeping user edits', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('issue link')

    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          messages: [userTextMessage('m1', 'sent from the TUI')],
          launchDraft: 'issue link'
        })
      )
    )
    expect(state?.composerText).toBe('')

    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'b', launchDraft: 'issue link' }))
    )
    act(() => state?.setComposerText('issue link plus my notes'))
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'b',
          messages: [userTextMessage('m2', 'sent from the TUI')],
          launchDraft: 'issue link'
        })
      )
    )
    expect(state?.composerText).toBe('issue link plus my notes')
  })

  it('holds the launch draft until the transcript read settles', async () => {
    // Launch drafts arrive before history; seeding from an unsettled empty list could duplicate an already-submitted prompt.
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', launchDraft: 'issue link', transcriptLoading: true })
      )
    )
    expect(state?.composerText).toBe('')

    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          launchDraft: 'issue link',
          messages: [userTextMessage('m1', 'already sent from the TUI')]
        })
      )
    )
    expect(state?.composerText).toBe('')
  })

  it('seeds once the transcript settles empty', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', launchDraft: 'issue link', transcriptLoading: true })
      )
    )
    expect(state?.composerText).toBe('')

    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('issue link')
  })

  it('holds the seed while the tab is not resolved to chat view', async () => {
    // Off-chat empty messages are no transcript evidence; using them could resurrect submitted launch text.
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', launchDraft: 'issue link', chatActive: false })
      )
    )
    expect(state?.composerText).toBe('')

    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          tabId: 'a',
          launchDraft: 'issue link',
          messages: [userTextMessage('m1', 'already sent from the TUI')]
        })
      )
    )
    expect(state?.composerText).toBe('')
  })

  it('keeps an adopted prefill when the tab momentarily drops out of the snapshot', async () => {
    // Transient tab omission looks like draft retraction without proving resolution.
    await mount('a')
    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('issue link')

    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', launchDraft: null, chatActive: false }))
    )
    expect(state?.composerText).toBe('issue link')

    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('issue link')
  })

  it('does not decline another tab’s prefill from the transcript it is still showing', async () => {
    // The first tab-b commit retains tab-a history until the effect resets it; loading marks that list untrusted.
    const carriedOver = [userTextMessage('m1', 'sent on a')]
    await mount('a')
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
    expect(state?.composerText).toBe('')

    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'b', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('issue link')
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

  it('clears an untouched prefill when the host stops publishing the launch draft', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', launchDraft: 'issue link' }))
    )
    expect(state?.composerText).toBe('issue link')

    await act(async () =>
      renderer?.update(createElement(Harness, { tabId: 'a', launchDraft: null }))
    )
    expect(state?.composerText).toBe('')
  })
})
