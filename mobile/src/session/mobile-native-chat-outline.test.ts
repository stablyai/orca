import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { deriveMobileNativeChatOutline } from './mobile-native-chat-render-data'

function user(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 0, source: 'transcript' }
}

function assistant(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 0,
    source: 'transcript'
  }
}

describe('deriveMobileNativeChatOutline', () => {
  it('emits one entry per user turn, carrying its data index', () => {
    const data = [
      user('u1', 'first question'),
      assistant('a1', 'first answer'),
      user('u2', 'second question'),
      assistant('a2', 'second answer')
    ]
    expect(deriveMobileNativeChatOutline(data)).toEqual([
      { index: 0, title: 'first question', subtitle: 'first answer' },
      { index: 2, title: 'second question', subtitle: 'second answer' }
    ])
  })

  it('uses the final assistant text of the turn as the subtitle', () => {
    // Intervening assistant/tool rows don't reset the subtitle; the last one wins.
    const data = [
      user('u1', 'go'),
      assistant('a1', 'starting'),
      assistant('a2', 'still working'),
      assistant('a3', 'all done'),
      user('u2', 'next')
    ]
    const [first] = deriveMobileNativeChatOutline(data)
    expect(first).toEqual({ index: 0, title: 'go', subtitle: 'all done' })
  })

  it('takes only the first non-blank line of a multi-line prompt', () => {
    const data = [user('u1', '\n\nrefactor the parser\nand add tests\nplease')]
    expect(deriveMobileNativeChatOutline(data)[0].title).toBe('refactor the parser')
  })

  it('truncates a long prompt line with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const title = deriveMobileNativeChatOutline([user('u1', long)])[0].title
    expect(title.length).toBe(80)
    expect(title.endsWith('…')).toBe(true)
  })

  it('omits the subtitle for a turn with no assistant reply yet', () => {
    const data = [user('u1', 'first'), assistant('a1', 'reply'), user('u2', 'latest')]
    const items = deriveMobileNativeChatOutline(data)
    expect(items[1]).toEqual({ index: 2, title: 'latest' })
    expect(items[1]).not.toHaveProperty('subtitle')
  })

  it('labels an image-only user turn so it stays reachable', () => {
    const data: NativeChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'image-ref', url: 'file:///a.jpg' }],
        timestamp: 0,
        source: 'transcript'
      }
    ]
    expect(deriveMobileNativeChatOutline(data)).toEqual([{ index: 0, title: 'Image' }])
  })

  it('makes no outline entry for the streaming bubble or pre-prompt history', () => {
    // Only user turns anchor entries; the assistant banter before the first
    // prompt and the synthetic streaming reply are never their own rows.
    const data: NativeChatMessage[] = [
      assistant('a0', 'pre-prompt banter'),
      user('u1', 'hi'),
      {
        id: 'streaming',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'live reply' }],
        timestamp: 0,
        source: 'hook'
      }
    ]
    expect(deriveMobileNativeChatOutline(data)).toEqual([
      { index: 1, title: 'hi', subtitle: 'live reply' }
    ])
  })

  it('returns nothing for a thread with no user turns', () => {
    expect(deriveMobileNativeChatOutline([assistant('a1', 'hello')])).toEqual([])
  })
})
