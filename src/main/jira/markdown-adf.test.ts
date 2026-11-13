import { describe, expect, it } from 'vitest'
import { markdownToAdf } from './markdown-adf'

const text = (value: string, marks?: unknown[]) =>
  marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }

describe('markdownToAdf', () => {
  it('keeps single newlines as line breaks and blank lines as paragraphs', async () => {
    // What Orca shows (remark-breaks) must match what Jira shows for the same comment.
    await expect(markdownToAdf('first\nsecond\n\nthird')).resolves.toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [text('first'), { type: 'hardBreak' }, text('second')] },
        { type: 'paragraph', content: [text('third')] }
      ]
    })
  })

  it('maps inline Markdown to ADF marks', async () => {
    const doc = await markdownToAdf('**bold** *em* ~~gone~~ `code` [link](https://example.com)')
    expect(doc.content).toEqual([
      {
        type: 'paragraph',
        content: [
          text('bold', [{ type: 'strong' }]),
          text(' '),
          text('em', [{ type: 'em' }]),
          text(' '),
          text('gone', [{ type: 'strike' }]),
          text(' '),
          text('code', [{ type: 'code' }]),
          text(' '),
          text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }])
        ]
      }
    ])
  })

  it('keeps code marks combined only with links', async () => {
    const doc = await markdownToAdf('**[`run`](https://example.com)**')
    expect(doc.content).toEqual([
      {
        type: 'paragraph',
        content: [
          text('run', [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'code' }])
        ]
      }
    ])
  })

  it('converts headings, lists, code blocks, quotes and rules', async () => {
    const doc = await markdownToAdf(
      '# Title\n\n- one\n- two\n\n3. three\n\n```ts\nconst a = 1\n```\n\n> quoted\n\n---'
    )
    expect(doc.content).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [text('one')] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [text('two')] }] }
        ]
      },
      {
        type: 'orderedList',
        attrs: { order: 3 },
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('three')] }] }]
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1')] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [text('quoted')] }] },
      { type: 'rule' }
    ])
  })

  it('rewrites blocks ADF forbids inside quotes and list items', async () => {
    const doc = await markdownToAdf('> # heading\n\n- ```\n  code\n  ```\n- [x] done')
    expect(doc.content).toEqual([
      { type: 'blockquote', content: [{ type: 'paragraph', content: [text('heading')] }] },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [] },
              { type: 'codeBlock', content: [text('code')] }
            ]
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [text('[x] '), text('done')] }]
          }
        ]
      }
    ])
  })

  it('builds header rows for GFM tables', async () => {
    const doc = await markdownToAdf('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(doc.content).toEqual([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [text('a')] }] },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [text('b')] }] }
            ]
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [{ type: 'paragraph', content: [text('1')] }] },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [text('2')] }] }
            ]
          }
        ]
      }
    ])
  })

  it('links only http(s) and mailto destinations', async () => {
    const doc = await markdownToAdf('[bad](javascript:alert(1)) [mail](mailto:a@b.co)')
    expect(doc.content).toEqual([
      {
        type: 'paragraph',
        content: [
          text('bad'),
          text(' '),
          text('mail', [{ type: 'link', attrs: { href: 'mailto:a@b.co' } }])
        ]
      }
    ])
  })

  it('keeps escaped punctuation as literal text', async () => {
    const doc = await markdownToAdf('\\*not em\\* and snake_case_name')
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [text('*not em* and snake_case_name')] }
    ])
  })
})
