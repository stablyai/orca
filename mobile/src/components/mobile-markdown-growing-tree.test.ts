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

  it('keeps a fenced block whole across its blank lines', () => {
    expect(grown('```\na\n\nb\n```\n\nafter')).toEqual([
      {
        type: 'code',
        lang: null,
        value: 'a\n\nb',
        closed: true,
        position: { start: { line: 1, column: 1 }, end: { line: 5, column: 1 } }
      },
      paragraph('after')
    ])
  })

  it('joins a line that stops being a heading to the paragraph above', () => {
    expect(grown('para\n#x')).toEqual([paragraph('para\n#x')])
  })

  it('makes one math block once a display formula closes past a blank line', () => {
    expect(grown('$$\nx\n\ny\n$$')).toEqual([
      { type: 'math', value: 'x\n\ny', source: '$$\nx\n\ny\n$$' }
    ])
  })
})
