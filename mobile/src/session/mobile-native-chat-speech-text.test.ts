import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  latestReplySpeechText,
  nativeChatSpeechChunks,
  nativeChatSpeechText
} from './mobile-native-chat-speech-text'

function message(role: NativeChatMessage['role'], text: string) {
  return { role, blocks: [{ type: 'text' as const, text }] }
}

describe('nativeChatSpeechText', () => {
  it('reads a reply the way it looks instead of its markdown', () => {
    const markdown = [
      '## Next steps',
      '- **Wait** for review -> merge',
      'Saved to `C:\\Users\\me\\repo\\docs\\CURRENT_TODOS.md`, see [the plan](https://x.dev/p).',
      '```bash',
      'rm -rf build',
      '```',
      'Fixes #15817.'
    ].join('\n')
    expect(nativeChatSpeechText(markdown)).toBe(
      'Next steps. Wait for review to merge. Saved to CURRENT TODOS.md, see the plan. (code skipped). Fixes number 15817.'
    )
  })

  it('reads table rows with their column names', () => {
    const markdown =
      '| # | Who | Done when |\n|---|---|---|\n| 1 | **me** | it builds. |\n| 2 | you | |'
    expect(nativeChatSpeechText(markdown)).toBe('1, Who: me, Done when: it builds. 2, Who: you.')
  })

  it('keeps math and comparisons, dropping only the markdown around them', () => {
    expect(nativeChatSpeechText('Use a * b when a > b, not *this*.\n> quoted line')).toBe(
      'Use a * b when a > b, not this. quoted line.'
    )
    expect(nativeChatSpeechText('2 * 3 * 4 is 24')).toBe('2 * 3 * 4 is 24.')
  })

  it('keeps an escaped pipe inside its table cell', () => {
    const markdown = '| Cmd | Use |\n|---|---|\n| ls \\| wc | count files |'
    expect(nativeChatSpeechText(markdown)).toBe('Cmd: ls wc, Use: count files.')
  })
})

describe('nativeChatSpeechChunks', () => {
  it('splits only at sentence ends and keeps every word', () => {
    const text = 'One is 0.5 long. Two. Three is here.'
    const chunks = nativeChatSpeechChunks(text, 20)
    expect(chunks).toEqual(['One is 0.5 long.', 'Two. Three is here.'])
    expect(chunks.join(' ')).toBe(text)
  })

  it('cuts a sentence longer than the limit instead of dropping its end', () => {
    const chunks = nativeChatSpeechChunks('a'.repeat(25), 10)
    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
  })
})

describe('latestReplySpeechText', () => {
  it('reads the newest reply, skipping replies that only ran tools', () => {
    const toolOnly = {
      role: 'assistant' as const,
      blocks: [{ type: 'tool-call' as const, name: 'Bash', input: { command: 'ls' } }]
    }
    expect(
      latestReplySpeechText([
        message('user', 'hi'),
        message('assistant', 'Old answer.'),
        message('user', 'next'),
        message('assistant', 'New answer.'),
        toolOnly
      ])
    ).toBe('New answer.')
  })

  it('returns null when nothing has been answered yet', () => {
    expect(latestReplySpeechText([message('user', 'hi')])).toBeNull()
  })
})
