import type { Nodes } from 'mdast'
import { describe, expect, it } from 'vitest'
import { parseMobileMarkdownTree, plainText } from './mobile-markdown-tree'

const content =
  '**单算 Runtime 执行引擎，平均每题 29.78 秒。**边界是开始执行到产出结果，已排除评测证据采集、评分和后续资源清理。'

function strongText(node: Nodes): string[] {
  if (node.type === 'strong') {
    return [plainText(node)]
  }
  return 'children' in node ? node.children.flatMap(strongText) : []
}

describe('mobile CJK emphasis', () => {
  it.each(['**平均每题 29.78 秒。** 边界', '**平均每题 29.78 秒**。边界'])(
    'already parses an unambiguous boundary: %s',
    (text) => {
      expect(strongText(parseMobileMarkdownTree(text, false))).toHaveLength(1)
    }
  )

  it('parses the complete bold sentence before adjacent Chinese prose', () => {
    const tree = parseMobileMarkdownTree(content, false)
    expect(strongText(tree)).toEqual(['单算 Runtime 执行引擎，平均每题 29.78 秒。'])
    expect(plainText(tree)).toBe(content.replaceAll('**', ''))
  })

  it.each([
    ['前文**（重点）**后文', '（重点）'],
    ['これは**重要。**続き', '重要。'],
    ['문장**중요。**계속', '중요。']
  ])('parses CJK punctuation boundaries: %s', (text, bold) => {
    expect(strongText(parseMobileMarkdownTree(text, false))).toEqual([bold])
  })

  it.each([
    '`**重点。**后文`',
    '```text\n**重点。**后文\n```',
    '\\*\\*重点。\\*\\*后文',
    'a**b.**c'
  ])('keeps literal text and non-CJK boundaries: %s', (text) => {
    expect(strongText(parseMobileMarkdownTree(text, false))).toEqual([])
  })

  it('keeps emphasis while a response is growing', () => {
    expect(strongText(parseMobileMarkdownTree(content, true))).toEqual([
      '单算 Runtime 执行引擎，平均每题 29.78 秒。'
    ])
  })
})
