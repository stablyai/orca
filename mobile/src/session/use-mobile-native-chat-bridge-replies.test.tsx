import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../../../src/shared/native-chat-streaming'
import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

const reply = (id: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text: id }],
  timestamp: null,
  source: 'transcript'
})
let renderer: ReactTestRenderer | undefined
afterEach(() => act(() => renderer?.unmount()))

function flags(messages: NativeChatMessage[], isWorking: boolean): boolean[] {
  act(() => {
    renderer = create(createElement(Harness, { messages, enabled: false, isWorking }))
  })
  const { disclosure } = renderer!.root.findByType(Result).props
  expect(disclosure.listMessages).toBe(messages)
  return messages.map((message, index) => disclosure.resolveRow(index, message).finalReply)
}

it('keeps only the last answer of each completed bridge turn copyable', () => {
  expect(
    flags(
      [userMessage('u1'), reply('progress'), reply('a1'), userMessage('u2'), reply('a2')],
      false
    )
  ).toEqual([false, false, true, false, true])
})

it('preserves earlier answers while the new response streams', () => {
  expect(
    flags(
      [userMessage('u1'), reply('a1'), userMessage('u2'), reply(NATIVE_CHAT_STREAMING_ID)],
      true
    )
  ).toEqual([false, true, false, false])
})

it('keeps a completed reply when the streaming overlay has no user boundary yet', () => {
  expect(flags([reply('partial-history-answer'), reply(NATIVE_CHAT_STREAMING_ID)], true)).toEqual([
    true,
    false
  ])
})
