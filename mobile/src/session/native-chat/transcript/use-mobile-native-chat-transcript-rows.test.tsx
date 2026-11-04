import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

function toolRow(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: { command: id }, state: 'completed' }],
    timestamp: null,
    source: 'transcript'
  }
}

function answer(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Done.' }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('how the structured lane draws its rows, as desktop does', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('folds a settled turn to its answer until the reader opens it, and only offers that where it hides something', () => {
    const messages = [
      userMessage('u1'),
      toolRow('a1'),
      answer('a2'),
      userMessage('u2'),
      answer('a3')
    ]
    const settledTurns = new Map([
      ['u1', { startedAt: 0, workedSeconds: 3 }],
      ['u2', { startedAt: 0, workedSeconds: 2 }]
    ])
    act(() => {
      renderer = create(
        createElement(Harness, { messages, enabled: true, isWorking: false, settledTurns })
      )
    })
    const read = () => {
      const { disclosure } = renderer!.root.findByType(Result).props
      return messages.map((message, index) => disclosure.resolveRow(index, message))
    }
    const settled = read()
    expect(settled.map((row) => row.foldedAway === true)).toEqual([
      false,
      true,
      false,
      false,
      false
    ])
    expect(settled[0]?.turnKey).toBe('u1')
    expect(settled[3]?.turnKey).toBeUndefined()

    act(() => renderer!.root.findByType(Result).props.disclosure.onToggleTurn('u1'))
    expect(read().some((row) => row.foldedAway)).toBe(false)
  })
})
