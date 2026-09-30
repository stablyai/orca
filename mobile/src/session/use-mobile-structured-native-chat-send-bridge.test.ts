import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'

const ORIGIN: MobileNativeChatSendOrigin = {
  draftKey: 'draft',
  draftEditGeneration: 0,
  pendingKey: 'pending',
  normalizedText: 'command',
  baselineOccurrences: 0,
  baselineTailMessageId: null,
  baselineResolved: true
}

describe('useMobileStructuredNativeChatSendBridge', () => {
  let renderer: ReactTestRenderer | null = null
  let sendWithOutcome: (text: string) => Promise<MobileNativeChatSendOutcome>
  const acceptSend = vi.fn()
  const captureSendOrigin = vi.fn(() => ORIGIN)
  const clearDraftForSend = vi.fn()
  const holdUnconfirmedSend = vi.fn()
  const onSendError = vi.fn()
  const restoreRejectedDraft = vi.fn()
  const sendStructured = vi.fn()

  function Harness({ agent }: { agent: AgentSessionHandleProvider }): null {
    sendWithOutcome = useMobileStructuredNativeChatSendBridge({
      agent,
      acceptSend,
      captureSendOrigin,
      clearDraftForSend,
      holdUnconfirmedSend,
      onSendError,
      restoreRejectedDraft,
      sendStructured
    }).sendWithOutcome
    return null
  }

  function mount(agent: AgentSessionHandleProvider): void {
    act(() => {
      renderer = create(createElement(Harness, { agent }))
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('optimistically echoes accepted commands owned by the active agent', async () => {
    sendStructured.mockResolvedValue('accepted')
    mount('claude')

    await expect(sendWithOutcome('/init')).resolves.toBe('accepted')

    expect(acceptSend).toHaveBeenCalledWith(ORIGIN, '/init', undefined)
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('holds unknown delivery for commands owned by the active agent', async () => {
    sendStructured.mockResolvedValue('unknown')
    mount('claude')

    await expect(sendWithOutcome('/review')).resolves.toBe('unknown')

    expect(holdUnconfirmedSend).toHaveBeenCalledWith(ORIGIN, '/review', expect.any(Function))
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('never echoes a queued send as an optimistic transcript bubble', async () => {
    // The host holds the draft and publishes it as a card above the composer;
    // a `pending-N` bubble here would show the message twice and retire never.
    sendStructured.mockResolvedValue('queued')
    mount('claude')

    await expect(sendWithOutcome('queue me')).resolves.toBe('queued')

    expect(acceptSend).not.toHaveBeenCalled()
    expect(holdUnconfirmedSend).not.toHaveBeenCalled()
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('keeps host-command reconciliation for Codex', async () => {
    sendStructured.mockResolvedValue('unknown')
    mount('codex')

    await expect(sendWithOutcome('/review')).resolves.toBe('unknown')

    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, '/review')
    expect(holdUnconfirmedSend).not.toHaveBeenCalled()
  })
})
