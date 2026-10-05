import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendWithOutcome = vi.fn()
const clearInputWrite = vi.fn()
const typeCommandWithOutcome = vi.fn()
vi.mock('./mobile-native-chat-send', () => ({
  sendMobileNativeChatMessageWithOutcome: (...args: unknown[]) => sendWithOutcome(...args),
  typeMobileNativeChatCommandWithOutcome: (...args: unknown[]) => typeCommandWithOutcome(...args),
  clearMobileNativeChatInput: (...args: unknown[]) => clearInputWrite(...args),
  openMobileNativeChatSendBudget: () => Date.now() + 15_000,
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS: 15_000,
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS: 2_000
}))
vi.mock('./mobile-native-chat-stale-input', () => ({
  healMobileNativeChatStaleInput: () => Promise.resolve(true)
}))

import type { RpcClient } from '../transport/rpc-client'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'
import { noteMobileChatInputGuard } from './mobile-native-chat-input-guard'
import { resetMobileNativeChatTerminalWritesForTests } from './mobile-native-chat-terminal-write-lock'

type Send = ReturnType<typeof useMobileNativeChatMessageSend>

const ORIGIN: MobileNativeChatSendOrigin = {
  draftKey: 'k',
  draftEditGeneration: 0,
  pendingKey: 'p',
  normalizedText: 'hello',
  baselineOccurrences: 0,
  baselineTailMessageId: null,
  baselineResolved: true
}

describe('phone composer actions carry one chat-input id (F2)', () => {
  let renderer: ReactTestRenderer | null = null
  let api: Send | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only forwards the client to mocked senders.
  const client = { sendRequest: vi.fn() } as unknown as RpcClient
  const restoreRejectedDraft = vi.fn()
  const onSendError = vi.fn()

  const mount = (): void => {
    function Probe(): null {
      api = useMobileNativeChatMessageSend({
        client,
        enabled: true,
        handleRef: { current: 'term' },
        deviceTokenRef: { current: 'device' },
        agentRef: { current: 'claude' },
        commandSendRef: { current: vi.fn() },
        captureSendOrigin: () => ORIGIN,
        readSeededLaunchDraftSeed: () => null,
        clearDraftForSend: vi.fn(),
        restoreRejectedDraft,
        acceptSend: vi.fn(),
        holdUnconfirmedSend: vi.fn(),
        onSendError
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
  }

  beforeEach(() => {
    sendWithOutcome.mockReset()
    sendWithOutcome.mockResolvedValue('accepted')
    clearInputWrite.mockReset()
    clearInputWrite.mockResolvedValue(true)
    typeCommandWithOutcome.mockReset()
    restoreRejectedDraft.mockReset()
    onSendError.mockReset()
    resetMobileNativeChatTerminalWritesForTests()
  })
  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
    api = null
  })

  it('tags the clear and the body with the same action when the host guards', async () => {
    noteMobileChatInputGuard(client, true)
    mount()
    await act(async () => {
      await api!.send('hello')
    })
    const clearAction = clearInputWrite.mock.calls[0]?.[0]?.chatInput
    const bodyAction = sendWithOutcome.mock.calls[0]?.[0]?.chatInput
    expect(clearAction?.actionId).toMatch(/^chat-/)
    expect(bodyAction).toEqual(clearAction)
  })

  it('sends untagged writes to a host without the guard', async () => {
    noteMobileChatInputGuard(client, false)
    mount()
    await act(async () => {
      await api!.send('hello')
    })
    expect(clearInputWrite.mock.calls[0]?.[0]).not.toHaveProperty('chatInput')
    expect(sendWithOutcome.mock.calls[0]?.[0]).not.toHaveProperty('chatInput')
  })

  it("shows the existing 'Message not sent' and restores the draft when the host refuses", async () => {
    noteMobileChatInputGuard(client, true)
    sendWithOutcome.mockResolvedValue('rejected')
    mount()
    await act(async () => {
      await api!.send('hello')
    })
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, 'hello')
  })
})
