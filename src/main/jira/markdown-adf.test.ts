import { expect, it } from 'vitest'
import { markdownToAdf } from './markdown-adf'
import { adfToMarkdownText } from './adf-markdown'

it('round-trips supported block structure and mixed inline marks', async () => {
  const source =
    '# Heading\n\n**one [two](https://example.com) three**\n\n*em* ~~strike~~ `code` [Ada](mailto:ada@example.com)\n\n3. item\n   - nested\n\n> quote\n\n---'
  expect(adfToMarkdownText(await markdownToAdf(source))).toBe(source)
})

it('preserves GFM table cells, literal pipes and inline code on read-back', async () => {
  const source = '| Name | Value |\n| --- | --- |\n| **bold** | `a\\|b` |\n| empty | |'
  expect(adfToMarkdownText(await markdownToAdf(source))).toBe(
    '| Name     | Value  |\n| -------- | ------ |\n| **bold** | `a\\|b` |\n| empty    |        |'
  )
})

it('keeps quoted unsupported structures as source rather than dropping content', async () => {
  expect(await markdownToAdf('> ---')).toEqual({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '---' }] }]
      }
    ]
  })
  expect(await markdownToAdf('> | a | b |\n> | - | - |\n> | c | d |')).toEqual({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '| a | b |' },
              { type: 'hardBreak' },
              { type: 'text', text: '| - | - |' },
              { type: 'hardBreak' },
              { type: 'text', text: '| c | d |' }
            ]
          }
        ]
      }
    ]
  })
})

it('retains source for unsupported destinations, footnotes and HTML', async () => {
  const doc = await markdownToAdf(
    '[local](../readme) ![local](../a.png) <kbd>key</kbd>\n\n[^note]: detail'
  )
  expect(doc).toEqual({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '[local](../readme)' },
          { type: 'text', text: ' ' },
          { type: 'text', text: '![local](../a.png)' },
          { type: 'text', text: ' ' },
          { type: 'text', text: '<kbd>' },
          { type: 'text', text: 'key' },
          { type: 'text', text: '</kbd>' }
        ]
      },
      { type: 'paragraph', content: [{ type: 'text', text: '[^note]: detail' }] }
    ]
  })
})

it('uses documented link and textual task fallbacks', async () => {
  const doc = await markdownToAdf('![diagram](https://example.com/a.png)\n\n- [x] done\n- [ ] next')
  expect(adfToMarkdownText(doc)).toBe(
    '[diagram](https://example.com/a.png)\n\n- \\[x] done\n- \\[ ] next'
  )
})

it('uses the renderer CJK emphasis and prose URL boundaries', async () => {
  expect(await markdownToAdf('**「重要」**です https://example.com。次')).toEqual({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '「重要」', marks: [{ type: 'strong' }] },
          { type: 'text', text: 'です ' },
          {
            type: 'text',
            text: 'https://example.com',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }]
          },
          { type: 'text', text: '。次' }
        ]
      }
    ]
  })
})

it('keeps code whitespace, language and embedded fences including in lists', async () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'example' }] },
              {
                type: 'codeBlock',
                attrs: { language: 'js' },
                content: [{ type: 'text', text: 'a  \n\n\nb\n```\n' }]
              }
            ]
          }
        ]
      }
    ]
  }
  expect(adfToMarkdownText(doc)).toBe('- example\n\n  ````js\n  a  \n\n\n  b\n  ```\n\n  ````')
})

it('escapes active literal syntax while keeping identifiers and bare links readable', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'snake_case & plain https://example.com/a_b?x=1&y=2 me@example.com **x** [x]'
          }
        ]
      }
    ]
  }
  expect(adfToMarkdownText(doc)).toBe(
    'snake_case & plain https://example.com/a_b?x=1&y=2 me@example.com \\*\\*x\\*\\* \\[x]'
  )
})

it('preserves media resolvers and falls back for rich Jira tables', () => {
  expect(
    adfToMarkdownText(
      {
        type: 'doc',
        content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1' } }] }]
      },
      {
        resolveMedia: () => '![screenshot](data:image/png;base64,YQ==)'
      }
    )
  ).toBe('![screenshot](data:image/png;base64,YQ==)')
  expect(
    adfToMarkdownText({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 2 },
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'merged' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'details' }] }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
  ).toBe('merged\n\ndetails')
})
