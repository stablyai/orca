import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parseInline, stripHtmlTags } from './markdown-blocks'

const ORIGINAL_TAGS = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g

describe('review Markdown unclosed tags', () => {
  it.each(['', '<b>before</b> '])('preserves an unclosed suffix after %s', (prefix) => {
    const suffix = '<a '.repeat(20_000)
    const text = prefix + suffix
    const result = runInNewContext('parse(text)', { parse: parseInline, text }, { timeout: 250 })
    expect(result).toEqual([{ kind: 'text', text: prefix.replace(ORIGINAL_TAGS, '') + suffix }])
  })

  it('preserves the original stripping grammar over generated markup', () => {
    const parts = [
      '<a ',
      '<b>',
      '</b>',
      '<a href="x">',
      '<custom-tag x>',
      '<',
      '>',
      'a',
      ' ',
      '/',
      '\n',
      '"',
      '<1>',
      '<a/>',
      '<a x<',
      '<a'
    ]
    let seed = 17
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    for (let index = 0; index < 5000; index++) {
      const text = Array.from(
        { length: 1 + (random() % 40) },
        () => parts[random() % parts.length]
      ).join('')
      expect(stripHtmlTags(text), text).toBe(text.replace(ORIGINAL_TAGS, ''))
    }
  })
})
