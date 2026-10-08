import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

function assistantMessage(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('useMobileNativeChatTurnDisclosure growing row', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('marks no row while a prompt is open', () => {
    const messages = [userMessage('u1'), assistantMessage('a1')]
    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: true, lineYields: true }))
    })
    const { disclosure } = renderer!.root.findByType(Result).props
    expect(disclosure.resolveRow(1, messages[1]).mayStillGrow).toBe(false)
  })

  it('marks only the newest assistant row, even when a user row follows it', () => {
    const messages = [
      userMessage('u1'),
      assistantMessage('a1'),
      assistantMessage('a2'),
      userMessage('u2')
    ]
    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: true }))
    })
    const { disclosure } = renderer!.root.findByType(Result).props
    expect(
      messages.map((message, index) => disclosure.resolveRow(index, message).mayStillGrow)
    ).toEqual([false, false, true, false])
  })
})
