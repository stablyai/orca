import { expect, it } from 'vitest'
import { markdownToAdf } from './markdown-adf'
import { adfToMarkdownText } from './adf-markdown'
import { adfChildren, adfRecord } from './adf-nodes'

it('round-trips supported block structure and mixed inline marks', async () => {
  const source =
    '# Heading\n\n**one [two](https://example.com) three**\n\n*em* ~~strike~~ `code` [Ada](mailto:ada@example.com)\n\n3. item\n   - nested\n\n> quote\n\n---'
  expect(adfToMarkdownText(await markdownToAdf(source))).toBe(
    '# Heading\n\n**one [two](https://example.com) three**\n\n_em_ ~~strike~~ `code` [Ada](mailto:ada@example.com)\n\n3. item\n   - nested\n\n> quote\n\n---'
  )
})

it('preserves GFM table cells, literal pipes and inline code on read-back', async () => {
  const source = '| Name | Value |\n| --- | --- |\n| **bold** | `a\\|b` |\n| empty | |'
  expect(adfToMarkdownText(await markdownToAdf(source))).toBe(
    '| Name | Value |\n| - | - |\n| **bold** | `a\\|b` |\n| empty | |'
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
  const doc = await markdownToAdf('**「重要」**です https://example.com。次')
  expect(doc).toMatchObject({
    content: [
      {
        content: expect.arrayContaining([
          { type: 'text', text: '「重要」', marks: [{ type: 'strong' }] },
          {
            type: 'text',
            text: 'https://example.com',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }]
          }
        ])
      }
    ]
  })
  expect(adfToMarkdownText(doc)).toBe(
    '**「重要」**です [https://example.com](https://example.com)。次'
  )
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
  expect(adfToMarkdownText(doc)).toBe('- example\n  ````js\n  a  \n\n\n  b\n  ```\n\n  ````')
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

it('keeps Jira smart links active and ordinary hard breaks readable', () => {
  expect(
    adfToMarkdownText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'inlineCard', attrs: { url: 'https://example.com/a_b?x=1&y=2' } },
            { type: 'hardBreak' },
            { type: 'text', text: 'next line' }
          ]
        }
      ]
    })
  ).toBe('https://example.com/a_b?x=1&y=2\nnext line')
})

it('retains reference destinations used by inert source fallbacks', async () => {
  const doc = await markdownToAdf(
    '[local][doc] ![plot][img]\n\n[doc]: ../readme.md\n[img]: ../plot.png'
  )
  expect(doc).toEqual({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '[local][doc]' },
          { type: 'text', text: ' ' },
          { type: 'text', text: '![plot][img]' }
        ]
      },
      { type: 'paragraph', content: [{ type: 'text', text: '[doc]: ../readme.md' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '[img]: ../plot.png' }] }
    ]
  })
})

it('preserves existing parenthesized and www links and split literal entities', () => {
  expect(
    adfToMarkdownText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'https://example.com/wiki/Foo_(bar) www.example.com me@example.com。次'
            },
            { type: 'hardBreak' },
            { type: 'text', text: '&am' },
            { type: 'text', text: 'p;' }
          ]
        }
      ]
    })
  ).toBe(
    'https://example.com/wiki/Foo_(bar) www.example.com [me@example.com](mailto:me@example.com)。次\n\\&amp;'
  )
})

it('preserves prose-separated URLs, IPv6 authorities and surrounding literal delimiters', () => {
  const values = [
    ['https://a.com。https://b.com', '<https://a.com>。<https://b.com>'],
    [
      'http://[::1]。next http://user@[::1]:8080/path',
      '<http://[::1]>。next <http://user@[::1]:8080/path>'
    ],
    [
      'https://example.com/Foo_(bar)) www.example.com',
      '<https://example.com/Foo_(bar)>) www.example.com'
    ],
    [
      'https://example.com/me@example.com me@example.com',
      'https://example.com/me@example.com me@example.com'
    ],
    // Intended: an overlapping local-part run does not create a second partial email.
    ['a@b.c!x@d.e', '[a@b.c](mailto:a@b.c)!x@d.e']
  ]
  for (const [value, expected] of values) {
    expect(
      adfToMarkdownText({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }]
      })
    ).toBe(expected)
  }
})

it('keeps literal entity spellings and code bytes in direct read-back', async () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '&#x3067; &#X41;' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '&#x3067; &#X41;', marks: [{ type: 'code' }] }]
      },
      { type: 'codeBlock', content: [{ type: 'text', text: '&#x3067; &#X41;' }] },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/?q=&#x3067;&r=&#X41;' } }]
          }
        ]
      }
    ]
  }
  expect(adfToMarkdownText(await markdownToAdf('\\&#X41;'))).toBe('\\&#X41;')
  const markdown = adfToMarkdownText(doc)
  expect(markdown).toContain(
    '\\&#x3067; \\&#X41;\n\n`&#x3067; &#X41;`\n\n```\n&#x3067; &#X41;\n```'
  )
  expect(
    adfToMarkdownText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'query',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/files?diff=split&w=1' } }]
            }
          ]
        }
      ]
    })
  ).toBe('[query](https://example.com/files?diff=split&w=1)')
  expect(await markdownToAdf(markdown)).toMatchObject({
    content: expect.arrayContaining([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/?q=&#x3067;&r=&#X41;' } }]
          }
        ]
      }
    ])
  })
  expect(
    adfToMarkdownText(
      {
        type: 'doc',
        content: [
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'entity-media' } }] }
        ]
      },
      { resolveMedia: () => '![img](https://example.com/?q=&#x3067;&r=&#X41;)' }
    )
  ).toBe('![img](https://example.com/?q=&#x3067;&r=&#X41;)')
})

it('escapes literal blocks without damaging pasted links or adjacent CJK marks', async () => {
  expect(
    adfToMarkdownText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '*literal* build log https://example.com/_next/static/a~b*c*.js ok'
            },
            { type: 'hardBreak' },
            { type: 'text', text: '# heading' },
            { type: 'hardBreak' },
            { type: 'text', text: '1. item' },
            { type: 'hardBreak' },
            { type: 'text', text: '=== ' }
          ]
        }
      ]
    })
  ).toBe(
    '\\*literal\\* build log https://example.com/_next/static/a~b*c*.js ok\n\\# heading\n1\\. item\n\\=== '
  )
  expect(
    await markdownToAdf(
      adfToMarkdownText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '「甲」', marks: [{ type: 'strong' }] },
              { type: 'text', text: '「乙」', marks: [{ type: 'em' }] }
            ]
          }
        ]
      })
    )
  ).toEqual({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '「甲」', marks: [{ type: 'strong' }] },
          { type: 'text', text: '「乙」', marks: [{ type: 'em' }] }
        ]
      }
    ]
  })
})

it('keeps bare-link destinations separate from escaped text and mark delimiters', async () => {
  const cases = [
    {
      content: [{ type: 'text', text: '**see https://example.com/x**' }],
      markdown: '\\*\\*see <https://example.com/x>\\*\\*',
      text: '**see https://example.com/x**',
      linkText: 'https://example.com/x',
      href: 'https://example.com/x'
    },
    {
      content: [{ type: 'text', text: '<https://example.com>' }],
      markdown: '\\<<https://example.com>\\>',
      text: '<https://example.com>',
      linkText: 'https://example.com',
      href: 'https://example.com'
    },
    {
      content: [
        { type: 'inlineCard', attrs: { url: 'https://x.com/a' } },
        { type: 'text', text: '_note' }
      ],
      markdown: '<https://x.com/a>\\_note',
      text: 'https://x.com/a_note',
      linkText: 'https://x.com/a',
      href: 'https://x.com/a'
    },
    {
      content: [{ type: 'text', text: 'https://x.com/a', marks: [{ type: 'strong' }] }],
      markdown: '**<https://x.com/a>**',
      text: 'https://x.com/a',
      linkText: 'https://x.com/a',
      href: 'https://x.com/a',
      style: 'strong'
    },
    {
      content: [{ type: 'text', text: 'https://x.com/a', marks: [{ type: 'em' }] }],
      markdown: '_<https://x.com/a>_',
      text: 'https://x.com/a',
      linkText: 'https://x.com/a',
      href: 'https://x.com/a',
      style: 'em'
    },
    {
      content: [{ type: 'text', text: '!www.example.com*' }],
      markdown: '\\![www.example.com](http://www.example.com)\\*',
      text: '!www.example.com*',
      linkText: 'www.example.com',
      href: 'http://www.example.com'
    },
    {
      content: [
        { type: 'text', text: '!' },
        { type: 'text', text: 'me@example.com', marks: [{ type: 'strong' }] }
      ],
      markdown: '!**[me@example.com](mailto:me@example.com)**',
      text: '!me@example.com',
      linkText: 'me@example.com',
      href: 'mailto:me@example.com',
      style: 'strong'
    }
  ]
  for (const { content, markdown, text, linkText, href, style } of cases) {
    const actual = adfToMarkdownText({ type: 'doc', content: [{ type: 'paragraph', content }] })
    expect(actual).toBe(markdown)
    const doc = await markdownToAdf(actual)
    expect(doc).toMatchObject({ content: [{ type: 'paragraph' }] })
    const inline = adfChildren(adfRecord(adfChildren(doc.content)[0]).content)
    expect(inline.map((node) => adfRecord(node).text).join('')).toBe(text)
    expect(inline).toContainEqual({
      type: 'text',
      text: linkText,
      marks: [...(style ? [{ type: style }] : []), { type: 'link', attrs: { href } }]
    })
  }
})

it('preserves trailing whitespace outside inline marks', () => {
  const spaces = ' '.repeat(8)
  expect(
    adfToMarkdownText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: `a${spaces}`,
              marks: [{ type: 'strong' }, { type: 'em' }, { type: 'strike' }]
            }
          ]
        }
      ]
    })
  ).toBe(`**_~~a~~_**${spaces}`)
  for (const [text, expected] of [
    ['a\u00a0', '**a**\u00a0'],
    ['', ''],
    ['   ', '   ']
  ]) {
    expect(
      adfToMarkdownText({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'strong' }] }] }
        ]
      })
    ).toBe(expected)
  }
})

it('retains literal heading hashes and punctuation-edged marks on readback', async () => {
  for (const [source, markdown] of [
    ['# a \\#', '# a \\#'],
    ['# \\#', '# \\#'],
    ['**a!**&#98;', '**a!**&#98;'],
    ['&#97;**!b**', '&#97;**!b**'],
    ['**a!**&#946;', '**a!**&#946;']
  ]) {
    const doc = await markdownToAdf(source)
    expect(adfToMarkdownText(doc)).toBe(markdown)
    expect(await markdownToAdf(adfToMarkdownText(doc))).toEqual(doc)
  }
})

it('serializes tables without padding every row to the widest cell', () => {
  const wideCell = 'a'.repeat(800)
  const rows = Array.from({ length: 100 }, (_, index) => ({
    type: 'tableRow',
    content: [index === 0 ? wideCell : 'a', 'b'].map((text) => ({
      type: 'tableCell',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    }))
  }))
  const output = adfToMarkdownText({ type: 'doc', content: [{ type: 'table', content: rows }] })
  expect(output).toBe(`| ${wideCell} | b |\n| - | - |${'\n| a | b |'.repeat(99)}`)
})

it('retains zero-based ordered-list starts through publication and read-back', async () => {
  const doc = await markdownToAdf('0. first\n1. second')
  expect(doc).toMatchObject({ content: [{ type: 'orderedList', attrs: { order: 0 } }] })
  expect(adfToMarkdownText(doc)).toBe('0. first\n1. second')
})

it('keeps GFM strike boundaries distinct from CJK attention boundaries', async () => {
  const doc = await markdownToAdf('~~a!~~&#20013;')
  expect(doc).toEqual({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a!', marks: [{ type: 'strike' }] },
          { type: 'text', text: '中' }
        ]
      }
    ]
  })
  expect(adfToMarkdownText(doc)).toBe('~~a!~~&#20013;')
  expect(await markdownToAdf(adfToMarkdownText(doc))).toEqual(doc)
})

it('joins adjacent code bytes only within the same link boundary before choosing fences', async () => {
  const content = [
    { type: 'text', text: 'a', marks: [{ type: 'code' }] },
    { type: 'text', text: 'b', marks: [{ type: 'code' }] },
    { type: 'hardBreak' },
    { type: 'text', text: 'a`', marks: [{ type: 'code' }] },
    { type: 'text', text: '`b', marks: [{ type: 'code' }] },
    { type: 'hardBreak' },
    {
      type: 'text',
      text: 'a',
      marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://a.test' } }]
    },
    {
      type: 'text',
      text: 'b',
      marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://a.test' } }]
    },
    {
      type: 'text',
      text: 'c',
      marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://b.test' } }]
    },
    { type: 'text', text: 'd', marks: [{ type: 'code' }] }
  ]
  const markdown = adfToMarkdownText({ type: 'doc', content: [{ type: 'paragraph', content }] })
  expect(markdown).toBe('`ab`\n```a``b```\n[`ab`](https://a.test)[`c`](https://b.test)`d`')
  expect(await markdownToAdf(markdown)).toEqual({
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'ab', marks: [{ type: 'code' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'a``b', marks: [{ type: 'code' }] },
          { type: 'hardBreak' },
          {
            type: 'text',
            text: 'ab',
            marks: [{ type: 'link', attrs: { href: 'https://a.test' } }, { type: 'code' }]
          },
          {
            type: 'text',
            text: 'c',
            marks: [{ type: 'link', attrs: { href: 'https://b.test' } }, { type: 'code' }]
          },
          { type: 'text', text: 'd', marks: [{ type: 'code' }] }
        ]
      }
    ]
  })
})

it('keeps ambiguous URL authorities active through real Markdown read-back', async () => {
  for (const { text, markdown, href } of [
    { text: 'http://[::1]/', markdown: '<http://[::1]/>', href: 'http://[::1]/' },
    { text: ' http://[::1]/ ', markdown: ' <http://[::1]/> ', href: 'http://[::1]/' },
    { text: 'http://foo_bar.com/', markdown: '<http://foo_bar.com/>', href: 'http://foo_bar.com/' },
    {
      text: 'www.foo_bar.com/',
      markdown: '[www.foo_bar.com/](http://www.foo_bar.com/)',
      href: 'http://www.foo_bar.com/'
    },
    { text: 'http://-foo.com/', markdown: '<http://-foo.com/>', href: 'http://-foo.com/' },
    { text: '*a*@b.com', markdown: '[\\*a\\*@b.com](mailto:*a*@b.com)', href: 'mailto:*a*@b.com' },
    { text: '_a_@b.com', markdown: '[\\_a\\_@b.com](mailto:_a_@b.com)', href: 'mailto:_a_@b.com' },
    {
      text: ['https://example.com', '/docs'],
      markdown: 'https://example.com/docs',
      href: 'https://example.com/docs'
    }
  ]) {
    const fragments = [text].flat()
    const actual = adfToMarkdownText({
      type: 'doc',
      content: [
        { type: 'paragraph', content: fragments.map((value) => ({ type: 'text', text: value })) }
      ]
    })
    expect(actual).toBe(markdown)
    const result = await markdownToAdf(actual)
    expect(result).toMatchObject({
      content: [
        {
          type: 'paragraph',
          content: expect.arrayContaining([
            {
              type: 'text',
              text: fragments.join('').trim(),
              marks: [{ type: 'link', attrs: { href } }]
            }
          ])
        }
      ]
    })
  }
})
