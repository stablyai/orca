import { mobileNativeChatDraftDestination } from './native-chat/composer/mobile-native-chat-draft-inputs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentId } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle'
import type { MobileNativeChatSendOrigin } from './native-chat/mobile-native-chat-pending-echo'
import type { MobileNativeChatSendIntent } from './native-chat/mobile-native-chat-send'
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
  const holdUnconfirmed = vi.fn<(clientMessageId: string, onUnconfirmed: () => void) => void>()

  function Harness({ agent }: { agent: StructuredAgentId }): null {
    sendWithOutcome = useMobileStructuredNativeChatSendBridge({
      agent,
      captureSendOrigin,
      clearDraftForSend,
      onSendError,
      restoreRejectedDraft,
      sendStructured,
      holdUnconfirmed
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

  it('hands back an unconfirmed send with its skills beside newer picks only at the deadline', async () => {
    recordMobileNativeChatSkillPick(ORIGIN.draftKey, {
      token: '$review',
      path: '/skills/review/SKILL.md'
    })
    sendStructured.mockImplementation(
      async (
        ...args: [unknown, unknown, unknown, unknown, unknown, MobileNativeChatSendIntent]
      ) => {
        args[5].onCreated?.('lost-id')
        editMobileNativeChatDraft(ORIGIN.draftKey, '$newer work')
        recordMobileNativeChatSkillPick(ORIGIN.draftKey, {
          token: '$newer',
          path: '/skills/newer/SKILL.md'
        })
        return 'unknown'
      }
    )
    mount('codex')

    await expect(sendWithOutcome('/review')).resolves.toBe('unknown')

    expect(restoreRejectedDraft).not.toHaveBeenCalled()
    expect(onSendError).not.toHaveBeenCalled()
    expect(holdUnconfirmed).toHaveBeenCalledWith('lost-id', expect.any(Function))
    act(() => holdUnconfirmed.mock.calls[0]![1]())
    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, '/review')
    expect(onSendError).toHaveBeenCalledWith('Not confirmed. Restored to the box.')
    expect(readMobileNativeChatPickedSkills(ORIGIN.draftKey).map((skill) => skill.name)).toEqual([
      'newer',
      'review'
    ])
  })

  it('puts a host command whose reply was lost back in the box', async () => {
    sendStructured.mockResolvedValue('unknown')
    mount('codex')

    await expect(sendWithOutcome('/compact')).resolves.toBe('unknown')

    expect(holdUnconfirmed).not.toHaveBeenCalled()
    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, '/compact', {
      preserveConversationCommands: true
    })
  })

  it('sends a queued message with its own skills and leaves the composer alone when refused', async () => {
    recordMobileNativeChatSkillPick(ORIGIN.draftKey, {
      token: '$draft',
      path: '/skills/draft/SKILL.md'
    })
    sendStructured.mockResolvedValue('rejected')
    mount('codex')
    const queuedSkill = { name: 'review', path: '/skills/review/SKILL.md' }

    await expect(
      sendWithOutcome('$review the PR', undefined, undefined, undefined, undefined, {
        queued: { images: [], files: [], skills: [queuedSkill], skillOrigin: '$review' }
      })
    ).resolves.toBe('rejected')

    expect(sendStructured.mock.calls[0]![4]).toEqual([queuedSkill])
    expect(clearDraftForSend).not.toHaveBeenCalled()
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })
})
