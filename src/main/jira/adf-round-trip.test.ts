import { describe, expect, it } from 'vitest'
import { adfRoundTripsThroughMarkdown } from './adf-round-trip'

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (value: string, marks?: unknown[]) =>
  marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }

describe('adfRoundTripsThroughMarkdown', () => {
  it('accepts formatting Orca can write back', async () => {
    const adf = doc(
      { type: 'heading', attrs: { level: 2, localId: 'x' }, content: [text('Plan')] },
      paragraph(
        text('Use '),
        text('bold', [{ type: 'strong' }]),
        text(' and '),
        text('docs', [{ type: 'link', attrs: { href: 'https://example.com', title: 't' } }]),
        { type: 'hardBreak' },
        text('next line')
      ),
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph(text('item'))] }]
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1\n')] }
    )
    await expect(adfRoundTripsThroughMarkdown(adf)).resolves.toBe(true)
  })

  it('tolerates empty paragraphs and line-edge spaces Markdown drops', async () => {
    const adf = doc(paragraph(text('first  ')), paragraph(), paragraph(text('  second')))
    await expect(adfRoundTripsThroughMarkdown(adf)).resolves.toBe(true)
  })

  it('accepts code whose lines look like closing fences', async () => {
    const adf = doc(
      { type: 'codeBlock', attrs: { language: 'md' }, content: [text('```\nstill code\n````')] },
      paragraph(text('after'))
    )
    await expect(adfRoundTripsThroughMarkdown(adf)).resolves.toBe(true)
  })

  it.each([
    ['media', doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: '1' } }] })],
    ['mentions', doc(paragraph({ type: 'mention', attrs: { id: 'a', text: '@Ada' } }))],
    [
      'panels',
      doc({ type: 'panel', attrs: { panelType: 'info' }, content: [paragraph(text('x'))] })
    ],
    ['text colors', doc(paragraph(text('red', [{ type: 'textColor', attrs: { color: '#f00' } }])))],
    ['underline', doc(paragraph(text('u', [{ type: 'underline' }])))],
    // Unescaped list markers re-parse as a list, which would change the document.
    ['plain text that reads as Markdown', doc(paragraph(text('1. not a list')))]
  ])('rejects %s', async (_label, adf) => {
    await expect(adfRoundTripsThroughMarkdown(adf)).resolves.toBe(false)
  })
})
