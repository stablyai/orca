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

// Adoption and retirement of the host-published launch draft (the TUI-input
// prefill mirrored into the chat composer). Split from the send/pending suite
// so both stay under the per-file line cap.
describe('useMobileNativeChatDrafts launch draft', () => {
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
    messages = [],
    launchDraft = null,
    launchDraftCreatedAt = null,
    chatActive = true,
    transcriptLoading = false
  }: {
    tabId: string
    sessionId?: string | null
    messages?: NativeChatMessage[]
    launchDraft?: string | null
    launchDraftCreatedAt?: number | null
    chatActive?: boolean
    transcriptLoading?: boolean
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
      transcriptLoading
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

  it('prefills the composer from a host launch draft exactly once', async () => {
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', launchDraft: 'https://github.com/o/r/issues/12' })
      )
    )
    expect(state?.composerText).toBe('https://github.com/o/r/issues/12')

    // A user clear must not see the prefill resurrected on the next render.
    act(() => state?.setComposerText(''))
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', launchDraft: 'https://github.com/o/r/issues/12' })
      )
    )
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

    // Edited prefill survives resolution on another tab's copy.
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
    // `session.tabs` carries launchDraft before the transcript loads. Seeding on
    // the empty in-flight list would prefill an already-submitted issue link, and
    // a send tapped before it retracts duplicates it to the agent.
    await mount('a')
    await act(async () =>
      renderer?.update(
        createElement(Harness, { tabId: 'a', launchDraft: 'issue link', transcriptLoading: true })
      )
    )
    expect(state?.composerText).toBe('')

    // The settled transcript already holds the submitted turn — decline for good.
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
    // Off chat the session hook is not subscribed, so `messages` is empty for a
    // reason that says nothing about the transcript — judging the seed from it
    // would prefill an issue link the agent already submitted in the TUI.
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
    // A session-tabs frame can transiently omit the active tab: the draft then
    // reads as retracted and chat as inactive, but nothing was resolved.
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
    // The session hook resets its list in an effect, so the commit that first
    // sees tab b still carries tab a's turns. Only transcriptLoading says so.
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
