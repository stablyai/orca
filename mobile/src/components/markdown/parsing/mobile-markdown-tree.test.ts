import { describe, expect, it } from 'vitest'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'

describe('GitHub <details> sections', () => {
  it('nests the Markdown between the tags under its summary', () => {
    const source = [
      'Intro',
      '',
      '<details open>',
      '<summary>Logs <b>today</b></summary>',
      '',
      '- one',
      '',
      '</details>',
      '',
      'After'
    ].join('\n')
    expect(parseMobileMarkdownTree(source, false).children).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'Intro' }] },
      {
        type: 'details',
        open: true,
        summary: [
          { type: 'text', value: 'Logs ' },
          { type: 'strong', children: [{ type: 'text', value: 'today' }] }
        ],
        children: [
          {
            type: 'list',
            ordered: false,
            start: 1,
            children: [
              {
                type: 'listItem',
                checked: null,
                children: [{ type: 'paragraph', children: [{ type: 'text', value: 'one' }] }]
              }
            ]
          }
        ]
      },
      { type: 'paragraph', children: [{ type: 'text', value: 'After' }] }
    ])
  })

  it('ends a section left open when its quote ends', () => {
    const [quote, after] = parseMobileMarkdownTree(
      '> <details><summary>S</summary>\n>\n> body\n\nAfter',
      false
    ).children
    expect(quote).toMatchObject({
      type: 'blockquote',
      children: [{ type: 'details', open: false, children: [{ type: 'paragraph' }] }]
    })
    expect(after).toEqual({ type: 'paragraph', children: [{ type: 'text', value: 'After' }] })
  })

  it.each([
    ['a list item', '- a\n- b\n  </details>'],
    ['the end of a paragraph', 'body text</details>']
  ])('closes a section whose </details> sits in %s with that block', (_where, body) => {
    const types = parseMobileMarkdownTree(
      `<details>\n<summary>S</summary>\n\n${body}\n\nafter`,
      false
    ).children.map((node) => node.type)
    expect(types).toEqual(['details', 'paragraph'])
  })
})
