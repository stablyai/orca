import { mobileNativeChatDraftDestination } from './native-chat/composer/mobile-native-chat-draft-inputs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentId } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle'
import type { MobileNativeChatSendOrigin } from './native-chat/mobile-native-chat-pending-echo'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import {
  editMobileNativeChatDraft,
  recordMobileNativeChatSkillPick,
  readMobileNativeChatPickedSkills,
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
  let sendWithOutcome: ReturnType<typeof useMobileStructuredNativeChatSendBridge>['sendWithOutcome']
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

  it('retains transport-unknown input in the transcript without restoring the draft', async () => {
    recordMobileNativeChatSkillPick(ORIGIN.draftKey, {
      token: '$review',
      path: '/skills/review/SKILL.md'
    })
    sendStructured.mockImplementation(async () => {
      editMobileNativeChatDraft(ORIGIN.draftKey, '$newer work')
      recordMobileNativeChatSkillPick(ORIGIN.draftKey, {
        token: '$newer',
        path: '/skills/newer/SKILL.md'
      })
      return 'unknown'
    })
    mount('codex')

    await expect(sendWithOutcome('/review')).resolves.toBe('unknown')

    expect(restoreRejectedDraft).not.toHaveBeenCalled()
    expect(onSendError).not.toHaveBeenCalled()
    expect(readMobileNativeChatPickedSkills(ORIGIN.draftKey).map((skill) => skill.name)).toEqual([
      'newer'
    ])
  })
})
