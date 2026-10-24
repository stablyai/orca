import { describe, expect, it } from 'vitest'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'
import { splitMobileNativeChatFileAttachments } from '../session/mobile-native-chat-file-attachments'

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

  it('keeps CJK bold and literal file references while extracting the prose attachment', () => {
    const path = '/root/.orca/agent-session-attachments/id/report.pdf'
    const text = `**中文。**后文 \` @${path} \` and @${path} please.`
    expect(inlineNodes(text)).toContainEqual({
      type: 'strong',
      children: [{ type: 'text', value: '中文。' }]
    })
    expect(splitMobileNativeChatFileAttachments([{ type: 'text', text }])).toEqual({
      files: [path],
      prose: [{ type: 'text', text: `**中文。**后文 \` @${path} \` and please.` }]
    })
  })
})
