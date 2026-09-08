import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatAgentStatusWithProvider } from './mobile-native-chat-eligibility'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'

describe('useMobileNativeChatPrompts', () => {
  let renderer: ReactTestRenderer | null = null
  let prompts: ReturnType<typeof useMobileNativeChatPrompts> | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    prompts = null
  })

  function Harness({ status }: { status: MobileNativeChatAgentStatusWithProvider }): null {
    prompts = useMobileNativeChatPrompts({ enabled: true, status, messages: [] })
    return null
  }

  it('does not derive fallback cards from a structured ask', async () => {
    const status: MobileNativeChatAgentStatusWithProvider = {
      state: 'waiting',
      interactivePrompt: JSON.stringify({
        questions: [
          {
            question: 'Proceed?',
            options: [{ label: 'Allow' }, { label: 'Deny' }]
          }
        ]
      }),
      lastAssistantMessage: 'Proceed?\n1. Allow\n2. Deny'
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { status }))
      })
    } finally {
      consoleSpy.mockRestore()
    }

    expect(prompts?.ask?.questions[0]?.question).toBe('Proceed?')
    expect(prompts?.permission).toBeNull()
    expect(prompts?.question).toBeNull()
  })
})
