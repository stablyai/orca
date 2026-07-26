import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const acceptSend = vi.fn()
const captureSendOrigin = vi.fn()
const holdUnconfirmedSend = vi.fn()

// The controller composes many session hooks; each is mocked to a minimal shape
// so this test isolates the send seam (outcome -> drafts accounting).
vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({ isTabChatView: () => true, toggleTabChatView: vi.fn() })
}))
vi.mock('./use-mobile-native-chat-session', () => ({
  useMobileNativeChatSession: () => ({ messages: [] })
}))
vi.mock('./use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => ({
    composerText: '',
    setComposerText: vi.fn(),
    pending: [],
    captureSendOrigin,
    acceptSend,
    holdUnconfirmedSend
  })
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
vi.mock('./mobile-native-chat-send', () => ({
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
  // Only the stale-input heal reaches the transport directly (the message send
  // itself is mocked above).
  const clientStub = { sendRequest: vi.fn() }

  function Harness(): null {
    controller = useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: null,
      activeSessionTabId: 'tab-1',
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError
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

  it('threads the optimistic-echo image URIs into acceptSend on an accepted send', async () => {
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(true)
    expect(acceptSend).toHaveBeenCalledWith(ORIGIN, 'look', ['file:///a.jpg'])
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

  it('reports a rejected send and posts no echo', async () => {
    sendWithOutcome.mockResolvedValue('rejected')
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(false)
    expect(acceptSend).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
  })
})
