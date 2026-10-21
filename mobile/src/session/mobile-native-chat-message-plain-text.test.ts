import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../src/shared/agent-session-host-status-rows'
import type { NativeChatBlock } from '../../../src/shared/native-chat-types'
import { nativeChatMessagePlainText } from './mobile-native-chat-message-plain-text'

describe('nativeChatMessagePlainText', () => {
  it.each(['user', 'assistant'] as const)(
    'joins %s prose blocks, keeps their whitespace, and leaves tools and images out',
    (role) => {
      const blocks: NativeChatBlock[] = [
        { type: 'text', text: '  indented first line\n' },
        { type: 'tool-call', name: 'Bash', input: { command: 'ls' } },
        { type: 'image-ref', path: '/attachment.png' },
        { type: 'text', text: '   \n' },
        { type: 'text', text: 'Second, with `code`.' }
      ]
      expect(nativeChatMessagePlainText({ role, blocks })).toBe(
        '  indented first line\n\n\nSecond, with `code`.'
      )
    }
  )

  it('copies the displayed host notice instead of its fallback wire text', () => {
    expect(
      nativeChatMessagePlainText({
        role: 'system',
        blocks: [{ type: 'text', text: 'fallback', presentation: 'history-item-too-large' }]
      })
    ).toBe(AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'])
  })

  it.each(['assistant', 'system', 'reasoning'] as const)(
    'leaves a visual line out of %s prose, but not one inside a code fence',
    (role) => {
      const text =
        'Chart:\n::orca-visual{file="usage.html"}\nDone.\n```\n::orca-visual{file="x.html"}\n```'
      expect(nativeChatMessagePlainText({ role, blocks: [{ type: 'text', text }] })).toBe(
        'Chart:\nDone.\n```\n::orca-visual{file="x.html"}\n```'
      )
    }
  )

  it('keeps literal own visual lines and surrounding whitespace exactly', () => {
    const text =
      '  Please repair this chart:\r\n::orca-visual{file="usage.html"}\r\n\r\n  - keep this\r\n'
    expect(nativeChatMessagePlainText({ role: 'user', blocks: [{ type: 'text', text }] })).toBe(
      text
    )
  })

  it('is empty for a message with no prose', () => {
    expect(
      nativeChatMessagePlainText({
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
      })
    ).toBe('')
  })
})
