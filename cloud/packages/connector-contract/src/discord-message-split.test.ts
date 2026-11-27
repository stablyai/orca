import { describe, expect, it } from 'vitest'
import { splitDiscordMessage } from './discord-message-split.js'

describe('splitDiscordMessage', () => {
  it('keeps an answer that fits as one message', () => {
    expect(splitDiscordMessage('Done: the build passes.')).toEqual(['Done: the build passes.'])
    expect(splitDiscordMessage('x'.repeat(2000))).toHaveLength(1)
  })

  it('gives no messages for an empty answer', () => {
    expect(splitDiscordMessage('\n\n  ')).toEqual([])
  })

  it('splits a 2,001-character answer into two parts of at most 2,000', () => {
    const parts = splitDiscordMessage('a'.repeat(2001))
    expect(parts).toEqual(['a'.repeat(2000), 'a'])
  })

  it('splits between paragraphs, then lines, then words', () => {
    expect(splitDiscordMessage('first paragraph here\n\nsecond one', 30)).toEqual([
      'first paragraph here',
      'second one'
    ])
    expect(splitDiscordMessage('first line is here\nsecond line', 25)).toEqual([
      'first line is here',
      'second line'
    ])
    expect(splitDiscordMessage('alpha beta gamma delta epsilon', 22)).toEqual([
      'alpha beta gamma delta',
      'epsilon'
    ])
  })

  it('never cuts an emoji in half', () => {
    const parts = splitDiscordMessage(`${'a'.repeat(19)}😀b`, 20)
    expect(parts).toEqual(['a'.repeat(19), '😀b'])
  })

  it('closes a code block a split falls in and opens it again with its language', () => {
    const code = ['```ts', 'const one = 1', 'const two = 2', 'const three = 3', '```'].join('\n')
    const parts = splitDiscordMessage(code, 40)
    expect(parts).toEqual([
      '```ts\nconst one = 1\nconst two = 2\n```',
      '```ts\nconst three = 3\n```'
    ])
    expect(parts.every((part) => part.length <= 40)).toBe(true)
  })

  it('does not reopen a code block that closed before the split', () => {
    const text = '```\nx\n```\nafter the block comes plain text'
    expect(splitDiscordMessage(text, 30)).toEqual([
      '```\nx\n```\nafter the block',
      'comes plain text'
    ])
  })

  it('ends, within the limit and losing nothing, when a fence is too long to reopen', () => {
    const fence = '`'.repeat(700)
    const parts = splitDiscordMessage(`${fence}\n${'x'.repeat(2000)}\n${fence}`)
    expect(parts).toHaveLength(2)
    expect(parts.every((part) => part.length <= 2000)).toBe(true)
    expect(parts.join('').split('x')).toHaveLength(2001)
  })
})
