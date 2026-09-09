import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatRole } from '../../../src/shared/native-chat-types'
import { mobileNativeChatPromptAnchorIndex } from './mobile-native-chat-prompt-anchor'

function transcript(...roles: NativeChatRole[]): NativeChatMessage[] {
  return roles.map((role, index) => ({
    id: `m${index}`,
    role,
    blocks: [{ type: 'text', text: role }],
    timestamp: index,
    source: 'transcript'
  }))
}

describe('mobileNativeChatPromptAnchorIndex', () => {
  it('finds the prompt directly above an answer', () => {
    expect(mobileNativeChatPromptAnchorIndex(transcript('user', 'assistant'), 1)).toBe(0)
  })

  it('skips tool and reasoning turns between the prompt and the answer', () => {
    const messages = transcript('user', 'reasoning', 'tool', 'assistant')
    expect(mobileNativeChatPromptAnchorIndex(messages, 3)).toBe(0)
  })

  it('anchors an older answer to its own prompt, not the newest one', () => {
    // user0 assistant1 user2 assistant3 — pressing on assistant1 must land on
    // user0, which is the whole reason this is nearest-above and not "last".
    const messages = transcript('user', 'assistant', 'user', 'assistant')
    expect(mobileNativeChatPromptAnchorIndex(messages, 1)).toBe(0)
    expect(mobileNativeChatPromptAnchorIndex(messages, 3)).toBe(2)
  })

  it('returns null when no prompt precedes the message', () => {
    expect(mobileNativeChatPromptAnchorIndex(transcript('assistant', 'assistant'), 1)).toBeNull()
  })

  it('returns null at the head of the list', () => {
    expect(mobileNativeChatPromptAnchorIndex(transcript('user', 'assistant'), 0)).toBeNull()
  })

  it('returns null for an empty transcript', () => {
    expect(mobileNativeChatPromptAnchorIndex([], 0)).toBeNull()
  })

  it('clamps an index that outruns the list instead of scanning past the end', () => {
    expect(mobileNativeChatPromptAnchorIndex(transcript('user', 'assistant'), 99)).toBe(0)
  })

  it('ignores system turns, which are not prompts the user wrote', () => {
    expect(mobileNativeChatPromptAnchorIndex(transcript('system', 'assistant'), 1)).toBeNull()
  })
})
