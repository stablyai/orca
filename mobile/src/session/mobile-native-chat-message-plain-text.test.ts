import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../src/shared/agent-session-host-status-rows'
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

  it('copies the displayed host notice instead of its fallback wire text', () => {
    expect(
      nativeChatMessagePlainText({
        blocks: [{ type: 'text', text: 'fallback', presentation: 'history-item-too-large' }]
      })
    ).toBe(AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'])
  })

  it('leaves a visual line out of the copied prose, but not one inside a code fence', () => {
    const text =
      'Chart:\n::orca-visual{file="usage.html"}\nDone.\n```\n::orca-visual{file="x.html"}\n```'
    expect(nativeChatMessagePlainText({ blocks: [{ type: 'text', text }] })).toBe(
      'Chart:\nDone.\n```\n::orca-visual{file="x.html"}\n```'
    )
  })

  it('is empty for a message with no prose', () => {
    expect(
      nativeChatMessagePlainText({ blocks: [{ type: 'tool-call', name: 'Read', input: {} }] })
    ).toBe('')
  })
})
