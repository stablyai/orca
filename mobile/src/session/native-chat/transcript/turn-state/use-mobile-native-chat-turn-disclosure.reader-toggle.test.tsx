import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'

import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

describe('useMobileNativeChatTurnDisclosure', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('lets the reader explicitly collapse a turn retained when older history supplies its opener', () => {
    const messages: NativeChatMessage[] = [
      userMessage('opener'),
      {
        ...userMessage('reading'),
        role: 'assistant',
        blocks: [{ type: 'tool-call', callId: 'read', name: 'Read', input: { path: '/tmp/file' } }]
      },
      { ...userMessage('answer'), role: 'assistant' }
    ]
    const settledTurns = new Map([['opener', { startedAt: 1, workedSeconds: 10 }]])
    const draw = (rows: NativeChatMessage[]) =>
      createElement(Harness, { messages: rows, enabled: true, isWorking: false, settledTurns })
    act(() => {
      renderer = create(draw(messages.slice(1)))
    })
    act(() => {
      renderer!.update(draw(messages))
    })
    const retained = renderer!.root.findByType(Result).props.disclosure
    expect(retained.resolveRow(1, messages[1]!).foldedAway).toBeUndefined()
    expect(retained.resolveRow(1, messages[1]!).turnExpanded).toBe(true)
    act(() => retained.onToggleTurn('opener'))
    const collapsed = renderer!.root.findByType(Result).props.disclosure
    expect(collapsed.resolveRow(1, messages[1]!).foldedAway).toBe(true)
    expect(collapsed.resolveRow(1, messages[1]!).turnExpanded).toBe(false)
    act(() => {
      renderer!.update(draw([...messages]))
    })
    expect(
      renderer!.root.findByType(Result).props.disclosure.resolveRow(1, messages[1]!).foldedAway
    ).toBe(true)
  })
})
