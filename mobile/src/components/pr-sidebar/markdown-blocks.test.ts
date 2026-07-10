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
    expect(blocks[2]).toEqual({ kind: 'code', text: 'const x = 1', lang: '' })
    expect(blocks[3]).toEqual({ kind: 'quote', text: 'quoted' })
    expect(blocks[4]).toEqual({ kind: 'list', ordered: false, items: ['one', 'two'] })
    expect(blocks[5]).toEqual({ kind: 'hr' })
    expect(blocks[6]).toEqual({ kind: 'list', ordered: true, items: ['first', 'second'] })
  })

  it('strips HTML comments (single-line and multi-line) before parsing', () => {
    const md = [
      '<!-- a template note -->',
      'Real text.',
      '<!--',
      'multi',
      'line',
      '-->',
      'More.'
    ].join('\n')
    const blocks = parseMarkdownBlocks(md)
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Real text.' },
      { kind: 'paragraph', text: 'More.' }
    ])
    // An inline comment inside a line is removed too.
    expect(parseMarkdownBlocks('before <!-- hide --> after')).toEqual([
      { kind: 'paragraph', text: 'before  after' }
    ])
  })

  it('parses <details>/<summary> into a collapsible block and <blockquote> into a quote', () => {
    const md = '<details><summary>More</summary>\n\nHidden text.\n\n</details>'
    const blocks = parseMarkdownBlocks(md)
    expect(blocks).toEqual([
      { kind: 'details', summary: 'More', body: [{ kind: 'paragraph', text: 'Hidden text.' }] }
    ])
    expect(parseMarkdownBlocks('<blockquote>quoted thing</blockquote>')).toEqual([
      { kind: 'quote', text: 'quoted thing' }
    ])
  })

  it('keeps text around an HTML block in order and strips stray inline tags', () => {
    const blocks = parseMarkdownBlocks('Before.\n<blockquote>q</blockquote>\nAfter <kbd>X</kbd>.')
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Before.' },
      { kind: 'quote', text: 'q' },
      { kind: 'paragraph', text: 'After <kbd>X</kbd>.' }
    ])
  })

  it('is total — never throws on empty, whitespace, or an unterminated fence', () => {
    expect(parseMarkdownBlocks('')).toEqual([])
    expect(() => parseMarkdownBlocks('   \n\n  ')).not.toThrow()
    const open = parseMarkdownBlocks('```\nunterminated')
    expect(open).toEqual([{ kind: 'code', text: 'unterminated', lang: '' }])
  })

  it('captures the fence language (e.g. mermaid) on the code block', () => {
    const blocks = parseMarkdownBlocks('```mermaid\ngraph TD; A-->B\n```')
    expect(blocks).toEqual([{ kind: 'code', text: 'graph TD; A-->B', lang: 'mermaid' }])
    const ts = parseMarkdownBlocks('``` ts\nconst x = 1\n```')
    expect(ts[0]).toEqual({ kind: 'code', text: 'const x = 1', lang: 'ts' })
  })
})

describe('parseMarkdownBlocks tables', () => {
  it('parses a basic pipe table', () => {
    const md = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
    expect(parseMarkdownBlocks(md)).toEqual([
      {
        kind: 'table',
        headers: ['A', 'B'],
        align: ['left', 'left'],
        rows: [
          ['1', '2'],
          ['3', '4']
        ]
      }
    ])
  })

  it('reads per-column alignment from the delimiter row', () => {
    const md = ['| L | C | R |', '| :--- | :---: | ---: |', '| a | b | c |'].join('\n')
    const block = parseMarkdownBlocks(md)[0]
    expect(block).toEqual({
      kind: 'table',
      headers: ['L', 'C', 'R'],
      align: ['left', 'center', 'right'],
      rows: [['a', 'b', 'c']]
    })
  })

  it('keeps inline-formatting markup in cells for later inline parsing', () => {
    const md = ['| Name | Note |', '| --- | --- |', '| **bold** | `code` |'].join('\n')
    expect(parseMarkdownBlocks(md)).toEqual([
      {
        kind: 'table',
        headers: ['Name', 'Note'],
        align: ['left', 'left'],
        rows: [['**bold**', '`code`']]
      }
    ])
  })

  it('handles tables without outer pipes and escaped pipes in cells', () => {
    const md = ['A | B', '--- | ---', 'x \\| y | z'].join('\n')
    expect(parseMarkdownBlocks(md)).toEqual([
      {
        kind: 'table',
        headers: ['A', 'B'],
        align: ['left', 'left'],
        rows: [['x | y', 'z']]
      }
    ])
  })

  it('does not treat prose containing a pipe as a table (no delimiter row)', () => {
    expect(parseMarkdownBlocks('this | that is just text')).toEqual([
      { kind: 'paragraph', text: 'this | that is just text' }
    ])
  })

  it('is total — a malformed/partial table degrades without throwing', () => {
    // Header + delimiter but no body rows: still a (bodyless) table, no crash.
    const headerOnly = parseMarkdownBlocks('| A | B |\n| --- | --- |')
    expect(headerOnly).toEqual([
      { kind: 'table', headers: ['A', 'B'], align: ['left', 'left'], rows: [] }
    ])
    // Ragged rows (fewer/more cells than headers) must not throw.
    const ragged = ['| A | B | C |', '| --- | --- | --- |', '| 1 |', '| 1 | 2 | 3 | 4 |']
    expect(() => parseMarkdownBlocks(ragged.join('\n'))).not.toThrow()
    expect(() => parseMarkdownBlocks('|||\n|:-:|')).not.toThrow()
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
