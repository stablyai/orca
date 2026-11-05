import type * as MobileNativeChatSendModule from '../mobile-native-chat-send'
import type { RpcClient } from '../../../transport/rpc-client'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatSendOutcome } from '../mobile-native-chat-send'

const sendWithOutcome = vi.fn()
const clearInputWrite = vi.fn()
const typeCommandWithOutcome = vi.fn()
vi.mock('../mobile-native-chat-send', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileNativeChatSendModule>()),
  sendMobileNativeChatMessageWithOutcome: (...args: unknown[]) => sendWithOutcome(...args),
  typeMobileNativeChatCommandWithOutcome: (...args: unknown[]) => typeCommandWithOutcome(...args),
  clearMobileNativeChatInput: (...args: unknown[]) => clearInputWrite(...args),
  openMobileNativeChatSendBudget: () => Date.now() + 15_000,
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS: 15_000,
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS: 2_000
}))
vi.mock('../mobile-native-chat-stale-input', () => ({
  healMobileNativeChatStaleInput: () => Promise.resolve(true)
}))

import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { resetMobileNativeChatTerminalWritesForTests } from '../mobile-native-chat-terminal-write-lock'

type Send = ReturnType<typeof useMobileNativeChatMessageSend>

describe('useMobileNativeChatMessageSend', () => {
  let renderer: ReactTestRenderer | null = null
  let api: Send | null = null
  const acceptSend = vi.fn()
  const captureSendOrigin = vi.fn(() => ({ draftKey: 'k', pendingKey: 'p' }) as never)
  const clearDraftForSend = vi.fn()
  const restoreRejectedDraft = vi.fn()
  const holdUnconfirmedSend = vi.fn()
  const onCommandSend = vi.fn()
  const commandSendRef = { current: onCommandSend }
  const agentRef = { current: null as string | null }
  let onSendError = vi.fn()

  const mount = (
    readSeededLaunchDraftSeed: () => { text: string; createdAt: number | null } | null,
    agent: string | null = 'claude'
  ): void => {
    agentRef.current = agent
    const client: RpcClient = {
      sendRequest: vi.fn<RpcClient['sendRequest']>(async () => ({
        id: 'read',
        ok: true,
        result: { terminal: { draft: readSeededLaunchDraftSeed()?.text } },
        _meta: { runtimeId: 'r' }
      })),
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    function Probe(): null {
      api = useMobileNativeChatMessageSend({
        client,
        enabled: true,
        handleRef: { current: 'term' },
        deviceTokenRef: { current: 'device' },
        agentRef,
        commandSendRef,
        captureSendOrigin,
        readSeededLaunchDraftSeed,
        clearDraftForSend,
        restoreRejectedDraft,
        acceptSend,
        holdUnconfirmedSend,
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
    typeCommandWithOutcome.mockResolvedValue('accepted')
    acceptSend.mockReset()
    captureSendOrigin.mockClear()
    clearDraftForSend.mockReset()
    restoreRejectedDraft.mockReset()
    holdUnconfirmedSend.mockReset()
    onCommandSend.mockReset()
    commandSendRef.current = onCommandSend
    onSendError = vi.fn()
    resetMobileNativeChatTerminalWritesForTests()
  })
  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
    api = null
  })

  it('binds classification to the agent that started the send', async () => {
    let resolveSend!: (outcome: MobileNativeChatSendOutcome) => void
    sendWithOutcome.mockReturnValue(
      new Promise<MobileNativeChatSendOutcome>((resolve) => {
        resolveSend = resolve
      })
    )
    mount(() => null, 'claude')
    let sending!: Promise<boolean>
    act(() => {
      sending = api!.send('$skill')
    })
    agentRef.current = 'codex'
    await act(async () => {
      resolveSend('accepted')
      await sending
    })
    expect(acceptSend).toHaveBeenCalledTimes(1)
  })

  it('records a command against the tab that started the send', async () => {
    let resolveSend!: (outcome: MobileNativeChatSendOutcome) => void
    sendWithOutcome.mockReturnValue(
      new Promise<MobileNativeChatSendOutcome>((resolve) => {
        resolveSend = resolve
      })
    )
    const originalRecorder = vi.fn()
    const nextRecorder = vi.fn()
    commandSendRef.current = originalRecorder
    mount(() => null)
    commandSendRef.current = originalRecorder
    let sending!: Promise<boolean>
    act(() => {
      sending = api!.send('/clear')
    })
    commandSendRef.current = nextRecorder
    await act(async () => {
      resolveSend('accepted')
      await sending
    })
    expect(originalRecorder).toHaveBeenCalledWith('/clear')
    expect(nextRecorder).not.toHaveBeenCalled()
  })
})
