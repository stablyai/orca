import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatRole } from '../../../src/shared/native-chat-types'
import { mobileNativeChatLatestPromptIndex } from './mobile-native-chat-prompt-anchor'

function transcript(...roles: NativeChatRole[]): NativeChatMessage[] {
  return roles.map((role, index) => ({
    id: `m${index}`,
    role,
    blocks: [{ type: 'text', text: role }],
    timestamp: index,
    source: 'transcript'
  }))
}

describe('mobileNativeChatLatestPromptIndex', () => {
  it('finds the newest prompt, not an older one', () => {
    expect(
      mobileNativeChatLatestPromptIndex(transcript('user', 'assistant', 'user', 'assistant'))
    ).toBe(2)
  })

  it('skips tool and reasoning turns after the prompt', () => {
    expect(
      mobileNativeChatLatestPromptIndex(transcript('user', 'reasoning', 'tool', 'assistant'))
    ).toBe(0)
  })

  it('returns the prompt itself when it is the last row', () => {
    expect(mobileNativeChatLatestPromptIndex(transcript('assistant', 'user'))).toBe(1)
  })

  it('returns null when the loaded transcript has no prompt', () => {
    expect(mobileNativeChatLatestPromptIndex(transcript('assistant', 'assistant'))).toBeNull()
    expect(mobileNativeChatLatestPromptIndex([])).toBeNull()
  })

  it('ignores system turns, which are not prompts the user wrote', () => {
    expect(mobileNativeChatLatestPromptIndex(transcript('system', 'assistant'))).toBeNull()
  })

  it('ignores pending echoes and resolves the loaded prompt in the rendered order', () => {
    const loaded = transcript('user', 'assistant', 'user', 'assistant')
    const pending = { ...loaded[0], id: 'pending' }
    expect(
      mobileNativeChatLatestPromptIndex(loaded, [loaded[2], loaded[3], loaded[0], pending])
    ).toBe(0)
    expect(mobileNativeChatLatestPromptIndex([loaded[1]], [loaded[1], pending])).toBeNull()
  })

  it('stays hidden when the newest loaded prompt is drawn outside the list', () => {
    const loaded = transcript('user', 'assistant', 'user')
    expect(mobileNativeChatLatestPromptIndex(loaded, loaded.slice(0, 2))).toBeNull()
  })
})
