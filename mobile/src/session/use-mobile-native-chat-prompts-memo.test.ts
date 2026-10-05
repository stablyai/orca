import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type * as PendingDecisionModule from '../../../src/shared/native-chat-pending-decision'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

const resolver = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../../../src/shared/native-chat-pending-decision', async (importOriginal) => {
  const actual = await importOriginal<typeof PendingDecisionModule>()
  return {
    ...actual,
    resolveTerminalChatDecision: (
      ...args: Parameters<typeof actual.resolveTerminalChatDecision>
    ) => {
      resolver.calls += 1
      return actual.resolveTerminalChatDecision(...args)
    }
  }
})

import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'

const MESSAGES: NativeChatMessage[] = []
const ABSENT = { state: 'absent' } as const

function Probe({ status }: { status: AgentStatusEntry }): null {
  useMobileNativeChatPrompts({
    enabled: true,
    status,
    messages: MESSAGES,
    transcriptLoading: false,
    asyncQuestions: ABSENT
  })
  return null
}

describe('useMobileNativeChatPrompts memo', () => {
  it('re-resolves only when a field the resolver reads changes', () => {
    const status = (
      updatedAt: number,
      state: AgentStatusEntry['state'] = 'working'
    ): AgentStatusEntry => ({
      state,
      updatedAt,
      stateStartedAt: 1,
      prompt: '',
      paneKey: 'tab-1:leaf-1',
      stateHistory: []
    })
    let renderer: TestRenderer.ReactTestRenderer | null = null
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Probe, { status: status(1) }))
    })
    const afterMount = resolver.calls
    TestRenderer.act(() => {
      renderer?.update(createElement(Probe, { status: status(2) }))
    })
    expect(resolver.calls).toBe(afterMount)
    TestRenderer.act(() => {
      renderer?.update(createElement(Probe, { status: status(3, 'waiting') }))
    })
    expect(resolver.calls).toBe(afterMount + 1)
  })
})
