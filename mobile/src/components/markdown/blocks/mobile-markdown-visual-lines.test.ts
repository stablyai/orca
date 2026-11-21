import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE } from '../../../../../src/shared/native-chat/visuals/native-chat-visual-directive'
import { plainText } from '../parsing/mobile-markdown-plain-text'
import { parseMobileMarkdownTree } from '../parsing/mobile-markdown-tree'
import {
  mobileMarkdownCardPlaceholderIndex,
  mobileMarkdownVisualPlaceholderIndex,
  protectMobileMarkdownVisualLines
} from './mobile-markdown-visual-lines'

/** The top-level blocks drawn, with a lone placeholder paragraph read as its visual or card. */
function topLevelBlocks(text: string, visualCount: number, cardCount = 0) {
  return parseMobileMarkdownTree(text, false).children.map((node) => {
    const visual =
      node.type === 'paragraph'
        ? mobileMarkdownVisualPlaceholderIndex(plainText(node), visualCount)
        : null
    if (visual !== null) {
      return { type: 'visual', index: visual }
    }
    const card =
      node.type === 'paragraph'
        ? mobileMarkdownCardPlaceholderIndex(plainText(node), cardCount)
        : null
    if (card !== null) {
      return { type: 'card', index: card }
    }
    return node.type === 'code'
      ? { type: 'code', text: node.value, language: node.lang }
      : { type: node.type, text: plainText(node) }
  })
}

/** The same steps MobileMarkdown runs when a transcript renders visuals. */
function blocksOf(content: string) {
  const { text, directives, cards } = protectMobileMarkdownVisualLines(content)
  return { directives, cards, blocks: topLevelBlocks(text, directives.length, cards.length) }
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
      { type: 'code', text: '::orca-visual{file="a.html"}', language: 'md' }
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

  it('renders directives past the per-message cap as text', () => {
    const lines = Array.from(
      { length: NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE + 1 },
      (_, index) => `::orca-visual{file="v${index}.html"}`
    )
    const { directives, blocks } = blocksOf(lines.join('\n'))
    expect(directives).toHaveLength(NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE)
    expect(blocks.at(-1)).toEqual({ type: 'paragraph', text: lines.at(-1) })
  })

  it('keeps a literal placeholder and directive as text when they collide', () => {
    const placeholder = '\uE000ORCA_VISUAL_0\uE000'
    const directive = '::orca-visual{file="a.html"}'
    const { directives, blocks } = blocksOf(`${placeholder}\n\n${directive}`)
    expect(directives).toEqual([])
    expect(blocks).toEqual([
      { type: 'paragraph', text: placeholder },
      { type: 'paragraph', text: directive }
    ])
  })

  it('turns a webhook line into its own card block between prose', () => {
    const { directives, cards, blocks } = blocksOf(
      'It’s live.\n::orca-webhook{hook="wh_7Kx2pQ9mT4vB8nLc"}\nI’ll show you the first call.'
    )
    expect(directives).toEqual([])
    expect(cards).toEqual([{ kind: 'webhook', value: { hookId: 'wh_7Kx2pQ9mT4vB8nLc' } }])
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'It’s live.' },
      { type: 'card', index: 0 },
      { type: 'paragraph', text: 'I’ll show you the first call.' }
    ])
  })

  it('leaves a webhook line in a code fence as code', () => {
    const { blocks } = blocksOf('```\n::orca-webhook{hook="wh_7Kx2pQ9mT4vB8nLc"}\n```')
    expect(JSON.stringify(blocks)).toContain('::orca-webhook')
  })
})
