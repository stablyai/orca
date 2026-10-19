import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createMarkdownInlineMatcher } from './markdown-inline-matcher'
import { parseInline } from './pr-sidebar/markdown-blocks'

const ORIGINAL_REVIEW =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g
const REVIEW_OTHER = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/g

function tokens(text: string, original: boolean) {
  const pattern = new RegExp(ORIGINAL_REVIEW)
  const matcher = original
    ? {
        get lastIndex() {
          return pattern.lastIndex
        },
        set lastIndex(value) {
          pattern.lastIndex = value
        },
        exec: () => pattern.exec(text)
      }
    : createMarkdownInlineMatcher(text, new RegExp(REVIEW_OTHER))
  const result: Array<{ text: string; index: number; end: number }> = []
  let match
  while ((match = matcher.exec())) {
    result.push({ text: match[0], index: match.index, end: matcher.lastIndex })
  }
  return result
}

describe('mobile inline link scanning', () => {
  it('preserves original token order', () => {
    const fragments = [
      '[',
      ']',
      '(',
      ')',
      '!',
      'a',
      ' ',
      '*',
      '**',
      '_',
      '__',
      '`',
      '~',
      '\n',
      '[a](b)',
      '![](x)',
      'https://x.y',
      '[bad]',
      'foo_bar',
      '[[nested](url)'
    ]
    let seed = 12345
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    for (let i = 0; i < 5000; i++) {
      const text = Array.from(
        { length: 1 + (random() % 40) },
        () => fragments[random() % fragments.length]
      ).join('')
      expect(tokens(text, false), text).toEqual(tokens(text, true))
    }
  })

  it.each([
    { name: 'unmatched labels', text: '['.repeat(60_000) },
    { name: 'unmatched destinations', text: '[a]('.repeat(12_000) }
  ])('keeps $name literal within the parser deadline', ({ text }) => {
    const result = runInNewContext('parse(text)', { parse: parseInline, text }, { timeout: 250 })
    expect(result).toEqual([{ kind: 'text', text }])
  })

  it('does not repeatedly search the suffix for absent non-link tokens', () => {
    const text = '[a](b)'.repeat(10_000)
    const pattern = new RegExp(REVIEW_OTHER)
    const originalExec = pattern.exec.bind(pattern)
    let calls = 0
    pattern.exec = (value) => {
      calls++
      return originalExec(value)
    }
    const matcher = createMarkdownInlineMatcher(text, pattern)
    let count = 0
    while (matcher.exec()) {
      count++
    }
    expect(count).toBe(10_000)
    expect(calls).toBe(1)
  })
})
