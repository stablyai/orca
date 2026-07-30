import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

const acceptSend = vi.fn()
const captureSendOrigin = vi.fn()
const clearDraftForSend = vi.fn()
const restoreRejectedDraft = vi.fn()
const holdUnconfirmedSend = vi.fn()

// Mutable stand-ins so the launch-draft wiring below can drive chat resolution
// and transcript state; defaults keep the send-seam tests unchanged.
const viewMode = { isTabChatView: (_tabId: string) => true }
const sessionState = { messages: [] as unknown[], status: 'ready', transcriptLoading: false }
const draftsArgs: Record<string, unknown>[] = []

// The controller composes many session hooks; each is mocked to a minimal shape
// so this test isolates the send seam (outcome -> drafts accounting).
vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    isTabChatView: (tabId: string) => viewMode.isTabChatView(tabId),
    toggleTabChatView: vi.fn()
  })
}))
vi.mock('./use-mobile-native-chat-session', () => ({
  useMobileNativeChatSession: () => sessionState
}))
vi.mock('./use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: (args: Record<string, unknown>) => {
    draftsArgs.push(args)
    return {
      composerText: '',
      setComposerText: vi.fn(),
      pending: [],
      captureSendOrigin,
      clearDraftForSend,
      restoreRejectedDraft,
      acceptSend,
      holdUnconfirmedSend
    }
  }
}))
vi.mock('./use-mobile-native-chat-prompts', () => ({
  useMobileNativeChatPrompts: () => ({ permission: null, question: null, ask: null })
}))
vi.mock('./use-mobile-native-chat-answer-send', () => ({
  useMobileNativeChatAnswerSend: () => ({ answerAsk: vi.fn(), cancelPending: vi.fn() })
}))
vi.mock('./mobile-native-chat-permission-send', () => ({
  useMobileNativeChatPermissionSend: () => vi.fn()
}))
vi.mock('./use-mobile-native-chat-stop', () => ({
  useMobileNativeChatStop: () => vi.fn()
}))
vi.mock('./use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))
// Partial: the stale-input heal reaches the real transport through image-send,
// which must read the REAL timeout constant, not a copy that can silently drift.
vi.mock('./mobile-native-chat-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-native-chat-send')>()),
  sendMobileNativeChatMessageWithOutcome: vi.fn()
}))

import { sendMobileNativeChatMessageWithOutcome } from './mobile-native-chat-send'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'
import {
  useMobileNativeChatController,
  type MobileNativeChatController
} from './use-mobile-native-chat-controller'

const sendWithOutcome = vi.mocked(sendMobileNativeChatMessageWithOutcome)

const ORIGIN = {
  draftKey: 'h\0w\0tab-1',
  pendingKey: 'h\0w\0tab-1\0session-1',
  normalizedText: 'look',
  baselineOccurrences: 0,
  baselineTailMessageId: null
}

describe('useMobileNativeChatController handleNativeChatSend', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatController | null = null
  const onSendError = vi.fn()
  const onSendResolved = vi.fn()
  // Only the stale-input heal reaches the transport directly (the message send
  // itself is mocked above).
  const clientStub = { sendRequest: vi.fn() }

  function Harness({ connState = 'connected' }: { connState?: ConnectionState }): null {
    controller = useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      connState,
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: null,
      activeSessionTabId: 'tab-1',
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError,
      onSendResolved
    })
    return null
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    resetMobileNativeChatStaleInputForTests()
    captureSendOrigin.mockReturnValue(ORIGIN)
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      if (typeof a[0] === 'string' && a[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...a)
    })
    try {
      act(() => {
        renderer = create(createElement(Harness))
      })
    } finally {
      spy.mockRestore()
    }
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
  })

  it('clears an orphaned image paste before a question-card answer (#10228)', async () => {
    // The chat overlay wires the question card straight to this send, bypassing
    // the image hook that used to own the only heal.
    markMobileNativeChatInputStale('term-1')
    clientStub.sendRequest.mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'r' }
    })
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(true)
    expect(clientStub.sendRequest).toHaveBeenCalledTimes(1)
    expect(clientStub.sendRequest.mock.calls[0]?.[1]).toMatchObject({
      terminal: 'term-1',
      text: '\x15',
      enter: false
    })
    expect(isMobileNativeChatInputStale('term-1')).toBe(false)
  })

  it('does not send when the healing clear is rejected, keeping the marker', async () => {
    markMobileNativeChatInputStale('term-1')
    clientStub.sendRequest.mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: false } },
      _meta: { runtimeId: 'r' }
    })
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(false)
    expect(sendWithOutcome).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
  })

  it('keeps the marker when Escape cancels an ask, which never submits the composer', async () => {
    markMobileNativeChatInputStale('term-1')
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatCancelAsk()
    })
    expect(accepted).toBe(true)
    // The clear would be swallowed by the live overlay but still acked, burning
    // the marker and leaving the paste to corrupt the next real message.
    expect(clientStub.sendRequest).not.toHaveBeenCalled()
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
  })

  it('retires a held failure banner when a card action is accepted', async () => {
    // The banner is route-owned and outlives the write that raised it, so an accepted
    // answer or permission reply must clear it too — not just a composer send.
    sendWithOutcome.mockResolvedValue('accepted')
    await act(async () => {
      await controller!.handleNativeChatCancelAsk()
    })
    expect(onSendResolved).toHaveBeenCalled()

    onSendResolved.mockClear()
    sendWithOutcome.mockResolvedValue('rejected')
    await act(async () => {
      await controller!.handleNativeChatCancelAsk()
    })
    expect(onSendResolved).not.toHaveBeenCalled()
  })

  it('threads the optimistic-echo image URIs into acceptSend on an accepted send', async () => {
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(true)
    expect(acceptSend).toHaveBeenCalledWith(ORIGIN, 'look', ['file:///a.jpg'])
    // Optimistic clear happens at send time, never a restore on success.
    expect(clearDraftForSend).toHaveBeenCalledWith(ORIGIN, 'look')
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('pre-clears the input line for a text-only send but never for an image send', async () => {
    // The image path pastes the image behind its OWN leading Ctrl+U and then calls
    // this send; a second clear here wipes the image off the input line and the
    // agent receives text alone while the echo bubble still shows the thumbnail.
    sendWithOutcome.mockResolvedValue('accepted')

    await act(async () => {
      await controller!.handleNativeChatSend('answer')
    })
    expect(sendWithOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'answer', clearInputFirst: true })
    )

    await act(async () => {
      await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(sendWithOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'look', clearInputFirst: false })
    )
  })

  it('holds an unknown-outcome send without posting the optimistic echo', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(true)
    expect(acceptSend).not.toHaveBeenCalled()
    expect(holdUnconfirmedSend).toHaveBeenCalledWith(ORIGIN, 'look', expect.any(Function))
    // Delivery-unknown usually means delivered — keep the composer clear.
    expect(clearDraftForSend).toHaveBeenCalledWith(ORIGIN, 'look')
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('preserves the unknown outcome on the WithOutcome surface for paste-first callers', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    let outcome = 'accepted'
    await act(async () => {
      outcome = await controller!.handleNativeChatSendWithOutcome('look', ['file:///a.jpg'])
    })
    // Image sends heal a possibly-orphaned paste off this — 'unknown' must not
    // collapse into the boolean 'sent' shape (#10228).
    expect(outcome).toBe('unknown')
    expect(holdUnconfirmedSend).toHaveBeenCalledWith(ORIGIN, 'look', expect.any(Function))
  })

  it('fails a send fast while the socket is down, before spending the heal budget', async () => {
    // The lease collapses a render after connState, so a question-card answer could
    // otherwise sit in `sending` for the whole 15s heal+send budget.
    markMobileNativeChatInputStale('term-1')
    await act(async () => {
      renderer?.update(createElement(Harness, { connState: 'connecting' }))
    })
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(false)
    expect(clientStub.sendRequest).not.toHaveBeenCalled()
    expect(sendWithOutcome).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent (disconnected)')
  })

  it('reports a rejected send and posts no echo', async () => {
    sendWithOutcome.mockResolvedValue('rejected')
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(false)
    expect(acceptSend).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    // A definite rejection puts the optimistically-cleared text back.
    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, 'look')
  })

  it('does not restore a rejected question answer into the composer', async () => {
    sendWithOutcome.mockResolvedValue('rejected')
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatQuestionAnswer('1')
    })

    expect(accepted).toBe(false)
    expect(clearDraftForSend).not.toHaveBeenCalled()
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
  })
})

describe('useMobileNativeChatController launch-draft wiring', () => {
  let renderer: ReactTestRenderer | null = null
  const clientStub = { sendRequest: vi.fn() }

  const chatTab = {
    type: 'terminal',
    id: 'tab-1',
    title: 'Claude',
    terminal: 'term-1',
    launchAgent: 'claude',
    launchDraft: 'https://github.com/o/r/issues/12',
    isActive: true
  }

  function Harness({ tab }: { tab: unknown }): null {
    useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      connState: 'connected',
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: tab as never,
      activeSessionTabId: 'tab-1',
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError: vi.fn(),
      onSendResolved: vi.fn()
    })
    return null
  }

  function render(tab: unknown): void {
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      if (typeof a[0] === 'string' && a[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...a)
    })
    try {
      act(() => {
        renderer = create(createElement(Harness, { tab }))
      })
    } finally {
      spy.mockRestore()
    }
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    draftsArgs.length = 0
    viewMode.isTabChatView = () => true
    sessionState.messages = []
    sessionState.status = 'ready'
    sessionState.transcriptLoading = false
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('forwards the tab launch draft and chat-active flag for a chat-resolved tab', () => {
    render(chatTab)

    expect(draftsArgs.at(-1)).toMatchObject({
      tabId: 'tab-1',
      launchDraft: 'https://github.com/o/r/issues/12',
      chatActive: true,
      transcriptLoading: false
    })
  })

  it('forwards the raw draft with chatActive false when the tab shows the terminal', () => {
    // Nulling the draft off-chat is indistinguishable from a host retraction and
    // permanently declines the prefill; the flag is what keeps them apart.
    viewMode.isTabChatView = () => false
    render(chatTab)

    expect(draftsArgs.at(-1)).toMatchObject({
      launchDraft: 'https://github.com/o/r/issues/12',
      chatActive: false
    })
  })

  it('forwards the session hook’s transcriptLoading, not its status', () => {
    // 'working' masks 'loading' in status, so only the read-phase signal is honest.
    sessionState.status = 'working'
    sessionState.transcriptLoading = true
    render(chatTab)

    expect(draftsArgs.at(-1)).toMatchObject({ transcriptLoading: true })
  })

  it('forwards a null draft for a tab that publishes none', () => {
    render({ ...chatTab, launchDraft: undefined })

    expect(draftsArgs.at(-1)).toMatchObject({ launchDraft: null, chatActive: true })
  })
})
