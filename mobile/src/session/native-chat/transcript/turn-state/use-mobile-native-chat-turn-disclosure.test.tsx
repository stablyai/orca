import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

describe('useMobileNativeChatTurnDisclosure', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps the live bar on every render until it settles in place', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages = [userMessage('u1')]
      const seen: unknown[] = []
      function Recorder({ isWorking }: { isWorking: boolean }): React.JSX.Element {
        const disclosure = useMobileNativeChatTurnDisclosure({
          messages,
          enabled: true,
          isWorking,
          scopeKey: 'host\0worktree\0tab-a'
        })
        seen.push(disclosure.resolveRow(0, messages[0]).turnStatus)
        return createElement('result', { disclosure })
      }
      act(() => {
        renderer = create(createElement(Recorder, { isWorking: true }))
      })
      vi.setSystemTime(6_000)
      seen.length = 0
      act(() => {
        renderer?.update(createElement(Recorder, { isWorking: false }))
      })
      expect(seen).not.toContain(null)
      expect(seen.at(-1)).toEqual({ startedAt: 1_000, thinking: false, workedSeconds: 5 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the open reasoning block the live line discloses', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  const block = (id: string, state: 'running' | 'completed'): NativeChatMessage => ({
    id,
    role: 'reasoning',
    blocks: [{ type: 'text', text: `${id} weighs two approaches` }],
    timestamp: null,
    source: 'transcript',
    state
  })
  const show = (
    messages: NativeChatMessage[],
    props: { thinking?: boolean; lineYields?: boolean }
  ) =>
    act(() => {
      const element = createElement(Harness, { messages, enabled: true, ...props })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  const latest = () => renderer!.root.findByType(Result).props.disclosure

  it('hides only that block, and lands it open once it ends if the reader opened it live', () => {
    const prompt = userMessage('u1')
    show([prompt, block('r-1', 'running')], { thinking: true })
    expect(latest().liveLine).toMatchObject({
      reasoning: { message: { id: 'r-1' } },
      reasoningExpanded: false
    })
    expect(latest().resolveRow(1, block('r-1', 'running')).reasoningIsLive).toBe(true)
    act(() => latest().onToggleReasoning('reasoning:r-1'))
    expect(latest().liveLine.reasoningExpanded).toBe(true)

    show([prompt, block('r-1', 'completed')], { thinking: false })
    expect(latest().liveLine).toMatchObject({ reasoning: null })
    const row = latest().resolveRow(1, block('r-1', 'completed'))
    expect(row).toMatchObject({ reasoningIsLive: false, reasoningExpanded: true })

    show([prompt, block('r-1', 'completed'), block('r-2', 'running')], { thinking: true })
    expect(latest().liveLine).toMatchObject({
      reasoning: { message: { id: 'r-2' } },
      reasoningExpanded: false
    })
  })
})
