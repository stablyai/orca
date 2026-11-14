import type { RootContent } from 'mdast'
import { describe, expect, it } from 'vitest'
import {
  parseGrowingMobileMarkdownTree,
  type MobileMarkdownTreeCache
} from './mobile-markdown-growing-tree'

describe('text growing a character at a time', () => {
  const noLinks = (): void => {}
  function grown(text: string): RootContent[] {
    let cache: MobileMarkdownTreeCache | null = null
    let children: RootContent[] = []
    for (let end = 1; end <= text.length; end += 1) {
      const parsed = parseGrowingMobileMarkdownTree(
        cache,
        text.slice(0, end).trim(),
        true,
        false,
        noLinks
      )
      cache = parsed.cache
      children = parsed.root.children
    }
    return children
  }
  const paragraph = (value: string) => ({ type: 'paragraph', children: [{ type: 'text', value }] })

  it('keeps a list that continues after a blank line as one list', () => {
    expect(grown('1. a\n\n2. b\n\nafter')).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 1,
        children: [
          { type: 'listItem', checked: null, children: [paragraph('a')] },
          { type: 'listItem', checked: null, children: [paragraph('b')] }
        ]
      },
      paragraph('after')
    ])
  })

  it('ends a quote at a display formula that closes past a blank line', () => {
    expect(grown('> a\n$$\n\nb\n$$')).toEqual([
      { type: 'blockquote', children: [paragraph('a')] },
      { type: 'math', value: 'b', source: '$$\n\nb\n$$' }
    ])
  })
})
