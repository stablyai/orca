// Covers the wiring the image-attachments suite structurally cannot: that hook
// injects its own baseSend stub, so it never observes the real send params.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendWithOutcome = vi.fn()
const clearInputWrite = vi.fn()
vi.mock('./mobile-native-chat-send', () => ({
  sendMobileNativeChatMessageWithOutcome: (...args: unknown[]) => sendWithOutcome(...args),
  clearMobileNativeChatInput: (...args: unknown[]) => clearInputWrite(...args),
  openMobileNativeChatSendBudget: () => Date.now() + 15_000,
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS: 15_000,
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS: 2_000
}))
vi.mock('./mobile-native-chat-stale-input', () => ({
  healMobileNativeChatStaleInput: () => Promise.resolve(true)
}))

import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite,
  resetMobileNativeChatTerminalWritesForTests
} from './mobile-native-chat-terminal-write-lock'
import { buildAgentTuiClearInputForText } from '../../../src/shared/agent-tui-input-clear'

type Send = ReturnType<typeof useMobileNativeChatMessageSend>

const DRAFT = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123'

describe('useMobileNativeChatMessageSend', () => {
  let renderer: ReactTestRenderer | null = null
  let api: Send | null = null
  const acceptSend = vi.fn()
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
    function Probe(): null {
      api = useMobileNativeChatMessageSend({
        client: { sendRequest: vi.fn() } as never,
        enabled: true,
        handleRef: { current: 'term' },
        deviceTokenRef: { current: 'device' },
        agentRef,
        commandSendRef,
        captureSendOrigin: () => ({ draftKey: 'k', pendingKey: 'p' }) as never,
        readSeededLaunchDraftSeed,
        clearDraftForSend: () => {},
        restoreRejectedDraft: () => {},
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

  const sentArgs = (): {
    clearInputFirst?: boolean
    resolvedLaunchDraft?: { text: string; createdAt: number }
  } =>
    sendWithOutcome.mock.calls[0]![0] as {
      clearInputFirst?: boolean
      resolvedLaunchDraft?: { text: string; createdAt: number }
    }
  const clearArgs = (): { clearInput?: string } =>
    (clearInputWrite.mock.calls[0]?.[0] ?? {}) as { clearInput?: string }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sendWithOutcome.mockReset()
    sendWithOutcome.mockResolvedValue('accepted')
    clearInputWrite.mockReset()
    clearInputWrite.mockResolvedValue(true)
    acceptSend.mockReset()
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

  it('sizes the pre-clear to every line of a parked launch draft', async () => {
    mount(() => ({ text: DRAFT, createdAt: 1 }))
    await act(async () => {
      await api!.send('hello')
    })
    expect(clearArgs().clearInput).toBe(buildAgentTuiClearInputForText(DRAFT))
  })

  it('issues the burst as its OWN write, before the body', async () => {
    // Bundled into the body write it arrived as literal Ctrl+U text.
    mount(() => ({ text: DRAFT, createdAt: 1 }))
    await act(async () => {
      await api!.send('hello')
    })
    expect(clearInputWrite).toHaveBeenCalledTimes(1)
    expect(sendWithOutcome).toHaveBeenCalledTimes(1)
    expect(clearInputWrite.mock.invocationCallOrder[0]).toBeLessThan(
      sendWithOutcome.mock.invocationCallOrder[0]!
    )
  })

  it('aborts without sending the body when the clear is rejected', async () => {
    // Sending on top of an uncleared line is exactly the concatenation bug.
    clearInputWrite.mockResolvedValue(false)
    mount(() => ({ text: DRAFT, createdAt: 1 }))
    let result: boolean | undefined
    await act(async () => {
      result = await api!.send('hello')
    })
    expect(result).toBe(false)
    expect(sendWithOutcome).not.toHaveBeenCalled()
  })

  it('drops the body write\u2019s own Ctrl+U prefix once the dedicated clear ran', async () => {
    // A Ctrl+U written immediately before body text in the SAME write arrives as
    // a literal control character, so it would head the received message.
    mount(() => ({ text: DRAFT, createdAt: 1 }))
    await act(async () => {
      await api!.send('hello')
    })
    expect(sentArgs().clearInputFirst).toBe(false)
    expect(sentArgs().resolvedLaunchDraft).toEqual({ text: DRAFT, createdAt: 1 })
  })

  it('keeps the single-Ctrl+U prefix when no dedicated clear ran', async () => {
    mount(() => null)
    await act(async () => {
      await api!.send('hello')
    })
    expect(sentArgs().clearInputFirst).toBe(true)
    expect(sentArgs().resolvedLaunchDraft).toBeUndefined()
  })

  it('writes no clear at all when nothing is parked on the line', async () => {
    mount(() => null)
    await act(async () => {
      await api!.send('hello')
    })
    expect(clearInputWrite).not.toHaveBeenCalled()
  })

  it('reads the draft at send time, so a retired seed stops widening the clear', async () => {
    let parked: { text: string; createdAt: number } | null = { text: DRAFT, createdAt: 1 }
    mount(() => parked)
    await act(async () => {
      await api!.send('first')
    })
    parked = null
    await act(async () => {
      await api!.send('second')
    })
    expect(sendWithOutcome.mock.calls[1]![0]).toMatchObject({ clearInputFirst: true })
    expect(clearInputWrite).toHaveBeenCalledTimes(1)
    expect(sendWithOutcome.mock.calls[0]![0]).toMatchObject({ clearInputFirst: false })
  })

  it('does not clear an image send after the image was pasted', async () => {
    // A second clear here would wipe the image that was just pasted.
    mount(() => ({ text: DRAFT, createdAt: 1 }))
    await act(async () => {
      await api!.send('caption', ['file:///a.png'])
    })
    expect(clearInputWrite).not.toHaveBeenCalled()
    expect(sentArgs().clearInputFirst).toBe(false)
    expect(sentArgs().resolvedLaunchDraft).toEqual({ text: DRAFT, createdAt: 1 })
  })

  it('does not resolve a composer seed from a question-card answer', async () => {
    mount(() => ({ text: DRAFT, createdAt: 1 }))
    await act(async () => {
      await api!.answerQuestion('1')
    })
    expect(sentArgs().resolvedLaunchDraft).toBeUndefined()
  })

  it('creates an optimistic echo for an ordinary chat send', async () => {
    mount(() => null)
    await act(async () => {
      await api!.send('hello')
    })
    expect(acceptSend).toHaveBeenCalledTimes(1)
    expect(onCommandSend).not.toHaveBeenCalled()
  })

  // The STA-3332 "Queued forever" regression: command sends dispatch into the
  // agent's TUI and never echo as user turns, so they must not create a pending
  // bubble that no transcript match can ever retire.
  it('never creates an optimistic echo for a catalog command send', async () => {
    mount(() => null)
    await act(async () => {
      await api!.send('/clear')
    })
    expect(acceptSend).not.toHaveBeenCalled()
    expect(onCommandSend).toHaveBeenCalledWith('/clear')
  })

  it('never creates an optimistic echo for an unknown slash token', async () => {
    // `/model` is not in Claude's autocomplete catalog, but the session-option
    // recorder still recognizes it without claiming a generic command ran.
    mount(() => null)
    await act(async () => {
      await api!.send('/model sonnet')
    })
    expect(acceptSend).not.toHaveBeenCalled()
    expect(onCommandSend).toHaveBeenCalledWith('/model sonnet')
  })

  it('classifies per agent: /model is a catalog command for Codex', async () => {
    mount(() => null, 'codex')
    await act(async () => {
      await api!.send('/model')
    })
    expect(acceptSend).not.toHaveBeenCalled()
    expect(onCommandSend).toHaveBeenCalledWith('/model')
  })

  it('holds only chat sends for transcript confirmation on a lost ack', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    mount(() => null)
    await act(async () => {
      await api!.send('/clear')
    })
    expect(holdUnconfirmedSend).not.toHaveBeenCalled()
    await act(async () => {
      await api!.send('hello')
    })
    expect(holdUnconfirmedSend).toHaveBeenCalledTimes(1)
  })

  it('dispatchCommand surfaces the outcome without echo or composer sync', async () => {
    mount(() => ({ text: DRAFT, createdAt: 1 }))
    let outcome: string | undefined
    await act(async () => {
      outcome = await api!.dispatchCommand('/model sonnet')
    })
    expect(outcome).toBe('accepted')
    expect(acceptSend).not.toHaveBeenCalled()
    expect(onCommandSend).not.toHaveBeenCalled()
    expect(sentArgs().resolvedLaunchDraft).toBeUndefined()
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

  it('rejects a question answer while another composed write holds the terminal', async () => {
    mount(() => null)
    // An image paste sequence is mid-flight into the same PTY.
    expect(acquireMobileNativeChatTerminalWrite('term')).toBe(true)

    let result: boolean | undefined
    await act(async () => {
      result = await api!.answerQuestion('1')
    })
    expect(result).toBe(false)
    expect(sendWithOutcome).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Answer not sent')

    releaseMobileNativeChatTerminalWrite('term')
    await act(async () => {
      result = await api!.answerQuestion('1')
    })
    expect(result).toBe(true)
    // The answer released its own hold on the way out.
    expect(acquireMobileNativeChatTerminalWrite('term')).toBe(true)
    releaseMobileNativeChatTerminalWrite('term')
  })
})
