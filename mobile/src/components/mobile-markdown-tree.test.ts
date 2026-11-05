import { describe, expect, it } from 'vitest'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'

function inlineNodes(source: string) {
  const [paragraph] = parseMobileMarkdownTree(source, false).children
  return paragraph?.type === 'paragraph' ? paragraph.children : []
}

describe('CJK emphasis in mobile markdown', () => {
  it('closes bold that ends in punctuation right before CJK text', () => {
    expect(
      inlineNodes('**单算 Runtime 执行引擎，平均每题 29.78 秒。**边界是开始执行到产出结果。')
    ).toContainEqual({
      type: 'strong',
      children: [{ type: 'text', value: '单算 Runtime 执行引擎，平均每题 29.78 秒。' }]
    })
  })

  it('keeps CommonMark flanking rules between non-CJK characters', () => {
    expect(inlineNodes('**Note.**Next')).toEqual([{ type: 'text', value: '**Note.**Next' }])
  })
})

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
})
