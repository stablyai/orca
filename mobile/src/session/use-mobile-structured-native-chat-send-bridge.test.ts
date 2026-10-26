import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'

const ORIGIN: MobileNativeChatSendOrigin = {
  draftKey: 'draft',
  draftEditGeneration: 0,
  pendingKey: 'pending',
  normalizedText: 'command',
  baselineOccurrences: 0,
  baselineTailMessageId: null,
  baselineResolved: true,
  sentAt: 0
}

describe('useMobileStructuredNativeChatSendBridge', () => {
  let renderer: ReactTestRenderer | null = null
  let sendWithOutcome: (text: string) => Promise<MobileNativeChatSendOutcome>
  const captureSendOrigin = vi.fn(() => ORIGIN)
  const clearDraftForSend = vi.fn()
  const onSendError = vi.fn()
  const restoreRejectedDraft = vi.fn()
  const sendStructured = vi.fn()

  function Harness({ agent }: { agent: StructuredAgentId }): null {
    sendWithOutcome = useMobileStructuredNativeChatSendBridge({
      agent,
      captureSendOrigin,
      clearDraftForSend,
      onSendError,
      restoreRejectedDraft,
      sendStructured
    }).sendWithOutcome
    return null
  }

  function mount(agent: StructuredAgentId): void {
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

  // Accepted messages remain host-owned; keep the composer cleared.
  it.each(['accepted', 'unknown', 'queued'] as const)(
    'leaves a %s send of a command the active agent owns to the structured session',
    async (outcome) => {
      sendStructured.mockResolvedValue(outcome)
      mount('claude')

      await expect(sendWithOutcome('/review')).resolves.toBe(outcome)

      expect(sendStructured).toHaveBeenCalledWith('/review')
      expect(clearDraftForSend).toHaveBeenCalledExactlyOnceWith(ORIGIN, '/review')
      expect(restoreRejectedDraft).not.toHaveBeenCalled()
    }
  )

  it('keeps host-command reconciliation for Codex', async () => {
    sendStructured.mockResolvedValue('unknown')
    mount('codex')

    await expect(sendWithOutcome('/review')).resolves.toBe('unknown')

    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, '/review')
  })

  it("reads another agent's sends by that agent's commands, never Codex's", async () => {
    sendStructured.mockResolvedValue('unknown')
    mount('grok')

    await expect(sendWithOutcome('/review')).resolves.toBe('unknown')

    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('puts a refused send back in the composer', async () => {
    sendStructured.mockResolvedValue('rejected')
    mount('claude')

    await expect(sendWithOutcome('hello')).resolves.toBe('rejected')

    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, 'hello')
  })
})
