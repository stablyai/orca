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
