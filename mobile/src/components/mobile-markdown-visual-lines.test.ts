import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE } from '../../../src/shared/native-chat-visual-directive'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { parseMobileMarkdown } from './mobile-markdown-parser'
import { protectMobileMarkdownVisualLines } from './mobile-markdown-visual-lines'

/** The same steps MobileMarkdown runs when a transcript renders visuals. */
function blocksOf(content: string) {
  const { text, directives } = protectMobileMarkdownVisualLines(content)
  return {
    directives,
    blocks: parseMobileMarkdown(normalizeMobileMarkdownPreviewHtml(text), directives.length)
  }
}

describe('native-chat visual lines in mobile markdown', () => {
  it('turns a directive line into its own block between prose', () => {
    const { directives, blocks } = blocksOf(
      'Here is the chart.\n::orca-visual{file="usage-3f2a.html" title="Usage"}\nIt shows a dip.'
    )
    expect(directives).toEqual([{ file: 'usage-3f2a.html', title: 'Usage' }])
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Here is the chart.' },
      { type: 'visual', index: 0 },
      { type: 'paragraph', text: 'It shows a dip.' }
    ])
  })

  it('keeps the title exactly as written, before entity decoding and tag stripping', () => {
    const { directives } = blocksOf('::orca-visual{file="a.html" title="<b>Q1</b> &amp; Q2"}')
    expect(directives).toEqual([{ file: 'a.html', title: '<b>Q1</b> &amp; Q2' }])
  })

  it('accepts CRLF line endings and up to three leading spaces', () => {
    const { blocks } = blocksOf('intro\r\n   ::orca-visual{file="a.html"}\r\nend')
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'visual', 'paragraph'])
  })

  it('leaves directives inside fenced code, quotes, list items and inline code as text', () => {
    const fenced = blocksOf('```md\n::orca-visual{file="a.html"}\n```')
    expect(fenced.directives).toEqual([])
    expect(fenced.blocks).toEqual([
      { type: 'code', text: '::orca-visual{file="a.html"}', language: 'md', closed: true }
    ])
    expect(blocksOf('> ::orca-visual{file="a.html"}').directives).toEqual([])
    expect(blocksOf('- ::orca-visual{file="a.html"}').directives).toEqual([])
    expect(blocksOf('see `::orca-visual{file="a.html"}`').directives).toEqual([])
    expect(blocksOf('    ::orca-visual{file="a.html"}').directives).toEqual([])
  })

  it('resumes recognizing directives after a fence closes', () => {
    const { directives } = blocksOf('```\ncode\n```\n::orca-visual{file="after.html"}')
    expect(directives).toEqual([{ file: 'after.html', title: null }])
  })

  it('leaves malformed or path-like directives as literal text', () => {
    for (const line of [
      '::orca-visual{file="../secret.html"}',
      '::orca-visual{file="a.html" file="b.html"}',
      '::orca-visual{file="a.htm"}',
      '::orca-visual{file="a.html"',
      '::orca-visual{file="a.html"} trailing words'
    ]) {
      const { directives, blocks } = blocksOf(line)
      expect(directives, line).toEqual([])
      expect(blocks, line).toEqual([{ type: 'paragraph', text: line }])
    }
  })

  it('renders directives past the per-message cap as text', () => {
    const lines = Array.from(
      { length: NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE + 1 },
      (_, index) => `::orca-visual{file="v${index}.html"}`
    )
    const { directives, blocks } = blocksOf(lines.join('\n'))
    expect(directives).toHaveLength(NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE)
    expect(blocks.at(-1)).toEqual({ type: 'paragraph', text: lines.at(-1) })
  })

  it('renders no visuals for text that already spells a placeholder', () => {
    const { directives } = blocksOf('\uE000ORCA_VISUAL_0\uE000\n::orca-visual{file="a.html"}')
    expect(directives).toEqual([])
  })

  it('never treats a placeholder-looking line as a visual when none were protected', () => {
    expect(parseMobileMarkdown('\uE000ORCA_VISUAL_0\uE000')).toEqual([
      { type: 'paragraph', text: '\uE000ORCA_VISUAL_0\uE000' }
    ])
  })
})
