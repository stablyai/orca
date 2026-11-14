import { expect, it, vi } from 'vitest'
import { emailCharacterReader } from './adf-bare-email'
import { httpCandidateNormalizer, httpCharacterReader } from './adf-http-link'
import { markdownToAdf } from './markdown-adf'
import { adfToMarkdownText } from './adf-markdown'
import { trailingWhitespaceReader } from './adf-text-marks'

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

it('bounds real email character reads through document read-back at N and 10N', () => {
  for (const length of [3200, 32000]) {
    const addresses = Math.floor(length / 15)
    const fixtures = [
      { value: 'A'.repeat(length), expected: 'A'.repeat(length) },
      { value: `${'a'.repeat(length - 2)}@x`, expected: `${'a'.repeat(length - 2)}@x` },
      {
        value: `${'@a. '.repeat(length / 4 - 1)}@a.x`,
        expected: `${'@a. '.repeat(length / 4 - 1)}@a.x`
      },
      {
        value: 'me@example.com '.repeat(addresses) + 'a'.repeat(length % 15),
        expected: 'me@example.com '.repeat(addresses) + 'a'.repeat(length % 15)
      }
    ]
    for (const { value, expected } of fixtures) {
      const visited = new Set<number>()
      let reads = 0
      const probe = vi.spyOn(emailCharacterReader, 'read').mockImplementation((input, index) => {
        reads++
        visited.add(index)
        return input[index]
      })
      try {
        const actual = adfToMarkdownText({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }]
        })
        expect(actual).toBe(expected)
        expect(visited.size).toBe(value.length)
        expect(reads).toBeLessThanOrEqual(
          3 * value.length + 2 * [...value].filter((char) => char === '@').length
        )
      } finally {
        probe.mockRestore()
      }
    }
  }
})

it('preserves prose-separated URLs, IPv6 authorities and surrounding literal delimiters', () => {
  const values = [
    ['https://a.com。https://b.com', '<https://a.com>。<https://b.com>'],
    [
      'http://[::1]。next http://user@[::1]:8080/path',
      '<http://[::1]>。next http://user@[::1]:8080/path'
    ],
    [
      'https://example.com/Foo_(bar)) www.example.com',
      '<https://example.com/Foo_(bar)>) www.example.com'
    ],
    [
      'https://example.com/me@example.com me@example.com',
      'https://example.com/me@example.com me@example.com'
    ],
    ['**see https://example.com/x**', '\\*\\*see <https://example.com/x>\\*\\*'],
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

it('bounds actual HTTP normalization reads and admission through document read-back at N and 10N', () => {
  for (const length of [800, 8000]) {
    const prefix = 'https://example.com/'
    const interior = `${prefix}${')'.repeat(length)}x`
    const trailing = `${prefix}${')'.repeat(length)}`
    const count = length / 8
    const pieces = 'https://a.com。'.repeat(count)
    const fixtures = [
      {
        value: interior,
        expected: `https://example.com/${')'.repeat(length)}x`,
        ranges: [[0, interior.length]]
      },
      {
        value: trailing,
        expected: `<https://example.com/>${')'.repeat(length)}`,
        ranges: [[0, trailing.length]]
      },
      {
        value: pieces,
        expected: '<https://a.com>。'.repeat(count),
        ranges: Array.from({ length: count }, (_, index) => [14 * index, 14 * index + 13])
      }
    ]
    for (const { value, expected, ranges } of fixtures) {
      const visited = new Set<number>()
      let reads = 0
      const probe = vi.spyOn(httpCharacterReader, 'read').mockImplementation((input, index) => {
        reads++
        visited.add(index)
        return input[index]
      })
      const admissions = vi.spyOn(httpCandidateNormalizer, 'normalize')
      try {
        expect(
          adfToMarkdownText({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }]
          })
        ).toBe(expected)
        for (const [start, end] of ranges) {
          expect(
            Array.from({ length: end - start }, (_, index) => visited.has(start + index)).every(
              Boolean
            ),
            'HTTP candidate coverage'
          ).toBe(true)
        }
        const actual = admissions.mock.calls.map(([, start, end]) => [start, end])
        expect(actual).toEqual(ranges)
        const bytes = actual.reduce((total, [start, end]) => total + end - start, 0)
        expect(bytes).toBeLessThanOrEqual(value.length)
        expect(actual.every(([start], index) => index === 0 || start >= actual[index - 1][1])).toBe(
          true
        )
        expect(reads).toBeLessThanOrEqual(3 * bytes + 2 * actual.length)
      } finally {
        probe.mockRestore()
        admissions.mockRestore()
      }
    }
  }
})

it('keeps literal entity spellings and code bytes in direct read-back', async () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '&#x3067;' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '&#x3067;', marks: [{ type: 'code' }] }]
      },
      { type: 'codeBlock', content: [{ type: 'text', text: '&#x3067;' }] },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/?q=&#x3067;' } }]
          }
        ]
      }
    ]
  }
  const markdown = adfToMarkdownText(doc)
  expect(markdown).toContain('\\&#x3067;\n\n`&#x3067;`\n\n```\n&#x3067;\n```')
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
            marks: [{ type: 'link', attrs: { href: 'https://example.com/?q=&#x3067;' } }]
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
      { resolveMedia: () => '![img](https://example.com/?q=&#x3067;)' }
    )
  ).toBe('![img](https://example.com/?q=&#x3067;)')
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
    const blocks = doc.content as { content: { text: string; marks?: unknown[] }[] }[]
    expect(blocks[0].content.map((node) => node.text).join('')).toBe(text)
    expect(blocks[0].content).toContainEqual({
      type: 'text',
      text: linkText,
      marks: [...(style ? [{ type: style }] : []), { type: 'link', attrs: { href } }]
    })
  }
})

it('bounds actual trailing-whitespace reads through marked document read-back at N and 10N', () => {
  for (const length of [800, 8000]) {
    const spaces = ' '.repeat(length)
    const cases = [
      { text: `a${spaces}b`, marks: ['strong'], expected: `**a${spaces}b**`, bound: 1, suffix: 1 },
      {
        text: `a${spaces}`,
        marks: ['strong'],
        expected: `**a**${spaces}`,
        bound: length + 1,
        suffix: length + 1
      },
      {
        text: `a${spaces}`,
        marks: ['strong', 'em', 'strike'],
        expected: `**_~~a~~_**${spaces}`,
        bound: 3 * (length + 1),
        suffix: length + 1
      }
    ]
    for (const { text, marks, expected, bound, suffix } of cases) {
      const visited = new Set<number>()
      let reads = 0
      const probe = vi
        .spyOn(trailingWhitespaceReader, 'read')
        .mockImplementation((value, index) => {
          reads++
          visited.add(index)
          return value[index]
        })
      try {
        expect(
          adfToMarkdownText({
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text, marks: marks.map((type) => ({ type })) }]
              }
            ]
          })
        ).toBe(expected)
        expect(reads, 'trailing whitespace endpoint coverage').toBeGreaterThan(0)
        expect(reads).toBeLessThanOrEqual(bound)
        for (let index = text.length - suffix; index < text.length; index++) {
          expect(visited.has(index), 'trailing whitespace endpoint coverage').toBe(true)
        }
      } finally {
        probe.mockRestore()
      }
    }
  }
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

it('bounds table output by cell content at N and 10N without widest-cell padding', () => {
  for (const [rowCount, width] of [
    [100, 800],
    [1000, 8000]
  ]) {
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      type: 'tableRow',
      content: [index === 0 ? 'a'.repeat(width) : 'a', 'b'].map((text) => ({
        type: 'tableCell',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      }))
    }))
    const output = adfToMarkdownText({ type: 'doc', content: [{ type: 'table', content: rows }] })
    const cellCharacters = width + 2 * rowCount - 1
    expect(output.length).toBeLessThanOrEqual(cellCharacters + 4 * 2 * (rowCount + 2))
    expect(output.split('\n')).toHaveLength(rowCount + 1)
    expect(output).toBe(
      `| ${'a'.repeat(width)} | b |\n| - | - |${'\n| a | b |'.repeat(rowCount - 1)}`
    )
  }
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
