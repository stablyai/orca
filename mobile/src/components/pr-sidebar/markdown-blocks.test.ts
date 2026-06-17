import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdownBlocks } from './markdown-blocks'

describe('parseMarkdownBlocks', () => {
  it('classifies headings, fenced code, quotes, lists, hr, and paragraphs', () => {
    const md = [
      '# Title',
      '',
      'A paragraph line.',
      '',
      '```',
      'const x = 1',
      '```',
      '> quoted',
      '- one',
      '- two',
      '---',
      '1. first',
      '2. second'
    ].join('\n')
    const blocks = parseMarkdownBlocks(md)
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'Title' })
    expect(blocks[1]).toEqual({ kind: 'paragraph', text: 'A paragraph line.' })
    expect(blocks[2]).toEqual({ kind: 'code', text: 'const x = 1' })
    expect(blocks[3]).toEqual({ kind: 'quote', text: 'quoted' })
    expect(blocks[4]).toEqual({ kind: 'list', ordered: false, items: ['one', 'two'] })
    expect(blocks[5]).toEqual({ kind: 'hr' })
    expect(blocks[6]).toEqual({ kind: 'list', ordered: true, items: ['first', 'second'] })
  })

  it('is total — never throws on empty, whitespace, or an unterminated fence', () => {
    expect(parseMarkdownBlocks('')).toEqual([])
    expect(() => parseMarkdownBlocks('   \n\n  ')).not.toThrow()
    const open = parseMarkdownBlocks('```\nunterminated')
    expect(open).toEqual([{ kind: 'code', text: 'unterminated' }])
  })
})

describe('parseInline', () => {
  it('tokenizes bold, italic, code, and links; leaves plain runs as text', () => {
    expect(parseInline('a **b** c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' c' }
    ])
    expect(parseInline('`code`')).toEqual([{ kind: 'code', text: 'code' }])
    expect(parseInline('see [docs](https://x.y)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'docs', url: 'https://x.y' }
    ])
  })

  it('leaves unbalanced markers as literal text', () => {
    expect(parseInline('a * b')).toEqual([{ kind: 'text', text: 'a * b' }])
  })
})
