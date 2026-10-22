import { describe, expect, it } from 'vitest'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'

function inlineNodes(source: string) {
  const [paragraph] = parseMobileMarkdownTree(source, false).children
  return paragraph?.type === 'paragraph' ? paragraph.children : []
}

describe('CJK emphasis in mobile markdown', () => {
  it.each([
    [
      '**单算 Runtime 执行引擎，平均每题 29.78 秒。**边界是开始执行到产出结果。',
      '单算 Runtime 执行引擎，平均每题 29.78 秒。'
    ],
    ['**「注意」**してください', '「注意」']
  ])('closes bold that ends in punctuation before CJK text: %s', (source, bold) => {
    expect(inlineNodes(source)).toContainEqual({
      type: 'strong',
      children: [{ type: 'text', value: bold }]
    })
  })

  it.each([
    ['non-CJK text after punctuation', '**Note.**Next', { type: 'text', value: '**Note.**Next' }],
    ['inline code', '`**单算。**边界`', { type: 'inlineCode', value: '**单算。**边界' }],
    ['escaped markers', '\\*\\*单算。\\*\\*边界', { type: 'text', value: '**单算。**边界' }]
  ])('keeps markers literal in %s', (_name, source, node) => {
    expect(inlineNodes(source)).toEqual([node])
  })
})
