import { mobileNativeChatDraftDestination } from './native-chat/composer/mobile-native-chat-draft-inputs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './native-chat/mobile-native-chat-pending-echo'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import {
  recordMobileNativeChatSkillPick,
  resetMobileNativeChatDraftStoreForTests
} from './native-chat/composer/mobile-native-chat-draft-store'

const ORIGIN: MobileNativeChatSendOrigin = {
  draftKey: 'draft',
  draftDestination: mobileNativeChatDraftDestination('draft'),
  draftEditGeneration: 0,
  pendingKey: 'pending',
  normalizedText: 'command',
  boundary: { afterMessageId: null },
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
    resetMobileNativeChatDraftStoreForTests()
  })

  it('sends the skills picked into the draft', async () => {
    const review = { name: 'review', path: '/skills/review/SKILL.md' }
    recordMobileNativeChatSkillPick(ORIGIN.draftKey, { token: '$review', path: review.path })
    sendStructured.mockResolvedValue('accepted')
    mount('codex')

    await sendWithOutcome('$review this')

    expect(sendStructured).toHaveBeenCalledWith('$review this', undefined, undefined, undefined, [
      review
    ])
  })

  // Accepted messages remain host-owned; keep the composer cleared.
  it.each(['accepted', 'unknown', 'queued'] as const)(
    'leaves a %s send of a command the active agent owns to the structured session',
    async (outcome) => {
      sendStructured.mockResolvedValue(outcome)
      mount('claude')

      await expect(sendWithOutcome('/review')).resolves.toBe(outcome)

      expect(sendStructured).toHaveBeenCalledWith('/review', undefined, undefined, undefined, [])
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
