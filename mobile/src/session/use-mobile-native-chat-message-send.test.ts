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
import { buildAgentTuiClearInputForText } from '../../../src/shared/agent-tui-input-clear'

type Send = ReturnType<typeof useMobileNativeChatMessageSend>

const DRAFT = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123'

describe('useMobileNativeChatMessageSend', () => {
  let renderer: ReactTestRenderer | null = null
  let api: Send | null = null

  const mount = (
    readSeededLaunchDraftSeed: () => { text: string; createdAt: number | null } | null
  ): void => {
    function Probe(): null {
      api = useMobileNativeChatMessageSend({
        client: { sendRequest: vi.fn() } as never,
        enabled: true,
        handleRef: { current: 'term' },
        deviceTokenRef: { current: 'device' },
        captureSendOrigin: () => ({ draftKey: 'k', pendingKey: 'p' }) as never,
        readSeededLaunchDraftSeed,
        clearDraftForSend: () => {},
        restoreRejectedDraft: () => {},
        acceptSend: () => {},
        holdUnconfirmedSend: () => {},
        onSendError: () => {}
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
})
