import { describe, expect, it } from 'vitest'
import { appendRequests, markdownToDocText } from './google-docs-markdown'

describe('Markdown for Docs', () => {
  it('turns marks into styles over the plain text', () => {
    const converted = markdownToDocText(
      '# Title\n\nSome **bold** and *italic* with `code` and a [link](https://acme.dev).\nwrapped line\n\n- one\n  - nested\n1. first'
    )
    expect(converted.text).toBe(
      'Title\nSome bold and italic with code and a link. wrapped line\none\n\tnested\nfirst'
    )
    const at = (word: string) => converted.text.indexOf(word)
    expect(converted.paragraphs).toEqual([
      { start: 0, end: 5, heading: 1 },
      { start: 6, end: at(' wrapped') + ' wrapped line'.length },
      { start: at('one'), end: at('one') + 3, list: 'bullet' },
      { start: at('\tnested'), end: at('\tnested') + 7, list: 'bullet' },
      { start: at('first'), end: at('first') + 5, list: 'numbered' }
    ])
    expect(converted.spans).toEqual([
      { start: at('bold'), end: at('bold') + 4, bold: true },
      { start: at('italic'), end: at('italic') + 6, italic: true },
      { start: at('code'), end: at('code') + 4, code: true },
      { start: at('link'), end: at('link') + 4, link: 'https://acme.dev' }
    ])
  })

  it('keeps code blocks verbatim and drops rules and table dividers', () => {
    const converted = markdownToDocText(
      '```\nconst a = **1**\n```\n---\n| a | b |\n|---|---|\n| 1 | 2 |'
    )
    expect(converted.text).toBe('const a = **1**\n| a | b |\n| 1 | 2 |')
    expect(converted.spans).toEqual([{ start: 0, end: 15, code: true }])
  })

  it('clears the inherited style before styling, and makes lists last-first', () => {
    const requests = appendRequests('- a\n\npara\n\n1. b', 10, false)
    expect(requests.slice(0, 4)).toEqual([
      { insertText: { location: { index: 10 }, text: 'a\npara\nb' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 10, endIndex: 18 },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType'
        }
      },
      { deleteParagraphBullets: { range: { startIndex: 10, endIndex: 18 } } },
      {
        updateTextStyle: {
          range: { startIndex: 10, endIndex: 18 },
          textStyle: {},
          fields: 'bold,italic,link,weightedFontFamily'
        }
      }
    ])
    expect(requests.slice(4)).toEqual([
      {
        createParagraphBullets: {
          range: { startIndex: 17, endIndex: 18 },
          bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN'
        }
      },
      {
        createParagraphBullets: {
          range: { startIndex: 10, endIndex: 11 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE'
        }
      }
    ])
  })
})
