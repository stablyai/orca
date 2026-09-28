import { describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../src/shared/native-chat-types'
import { nativeChatMessagePlainText } from './mobile-native-chat-message-plain-text'

describe('nativeChatMessagePlainText', () => {
  it('joins the prose blocks, keeps their whitespace, and leaves tool calls out', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'text', text: '  indented first line\n' },
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: '   \n' },
      { type: 'text', text: 'Second, with `code`.' }
    ]
    expect(nativeChatMessagePlainText({ blocks })).toBe(
      '  indented first line\n\n\nSecond, with `code`.'
    )
  })

  it('is empty for a message with no prose', () => {
    expect(
      nativeChatMessagePlainText({ blocks: [{ type: 'tool-call', name: 'Read', input: {} }] })
    ).toBe('')
  })
})
