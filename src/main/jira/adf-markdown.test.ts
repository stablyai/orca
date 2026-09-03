import { describe, expect, it, vi } from 'vitest'
import { adfToMarkdownText, collectAdfMediaAttrs } from './adf-markdown'
import { escapeMarkdownLinkDestination } from './adf-media-destination'

function paragraphWith(...content: unknown[]) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content }]
  }
}

describe('adfToMarkdownText link marks', () => {
  it('converts a text node link mark into a Markdown link', () => {
    const markdown = adfToMarkdownText(
      paragraphWith({
        type: 'text',
        text: 'Design spec',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/spec' } }]
      })
    )
    expect(markdown).toBe('[Design spec](https://example.com/spec)')
  })

  it('preserves surrounding unmarked text and multiple links', () => {
    const markdown = adfToMarkdownText(
      paragraphWith(
        { type: 'text', text: 'See ' },
        {
          type: 'text',
          text: 'alpha',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }]
        },
        { type: 'text', text: ' and ' },
        {
          type: 'text',
          text: 'beta',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/b' } }]
        },
        { type: 'text', text: '.' }
      )
    )
    expect(markdown).toBe('See [alpha](https://example.com/a) and [beta](https://example.com/b).')
  })

  it('nests strong/em/strike inside the link destination label', () => {
    const markdown = adfToMarkdownText(
      paragraphWith({
        type: 'text',
        text: 'Bold link',
        marks: [
          { type: 'strong' },
          { type: 'em' },
          { type: 'strike' },
          { type: 'link', attrs: { href: 'https://example.com/x' } }
        ]
      })
    )
    expect(markdown).toBe('[~~***Bold link***~~](https://example.com/x)')
  })

  it('wraps code marks inside the link label without nested emphasis', () => {
    const markdown = adfToMarkdownText(
      paragraphWith({
        type: 'text',
        text: 'fn()',
        marks: [
          { type: 'code' },
          { type: 'strong' },
          { type: 'link', attrs: { href: 'https://example.com/api' } }
        ]
      })
    )
    expect(markdown).toBe('[`fn()`](https://example.com/api)')
  })

  it('escapes markdown-hostile characters in labels and destinations', () => {
    const href = 'https://cdn.example/x?a=1)![z](https://evil.example/y'
    const markdown = adfToMarkdownText(
      paragraphWith({
        type: 'text',
        text: 'Label] with [brackets',
        marks: [{ type: 'link', attrs: { href } }]
      })
    )
    expect(markdown).toContain('[Label\\] with \\[brackets]')
    expect(markdown).toContain('%29')
    expect(markdown).not.toContain('](https://evil')
  })

  it('renders unsafe schemes as non-clickable text', () => {
    const markdown = adfToMarkdownText(
      paragraphWith(
        {
          type: 'text',
          text: 'run me',
          marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]
        },
        { type: 'text', text: ' ' },
        {
          type: 'text',
          text: 'local',
          marks: [{ type: 'link', attrs: { href: 'file:///etc/passwd' } }]
        },
        { type: 'text', text: ' ' },
        {
          type: 'text',
          text: 'empty',
          marks: [{ type: 'link', attrs: { href: '' } }]
        },
        { type: 'text', text: ' ' },
        {
          type: 'text',
          text: 'missing',
          marks: [{ type: 'link', attrs: {} }]
        }
      )
    )
    expect(markdown).toBe('run me local empty missing')
    expect(markdown).not.toContain('](')
  })

  it('preserves Unicode labels and punctuation around links', () => {
    const markdown = adfToMarkdownText(
      paragraphWith(
        { type: 'text', text: '読: ' },
        {
          type: 'text',
          text: '仕様書',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/仕様' } }]
        },
        { type: 'text', text: '!' }
      )
    )
    expect(markdown).toBe('読: [仕様書](https://example.com/仕様)!')
  })

  it('leaves plain-string Server/DC bodies unchanged', () => {
    expect(adfToMarkdownText('Plain wiki body with https://example.com raw')).toBe(
      'Plain wiki body with https://example.com raw'
    )
  })
})

describe('adfToMarkdownText media', () => {
  it('keeps a placeholder when media cannot be resolved', () => {
    const markdown = adfToMarkdownText({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
        {
          type: 'mediaSingle',
          attrs: { layout: 'center' },
          content: [
            {
              type: 'media',
              attrs: {
                id: 'media-uuid-1',
                type: 'file',
                collection: 'contentId-1',
                alt: 'screenshot.png'
              }
            }
          ]
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'After' }] }
      ]
    })

    expect(markdown).toBe('Before\n\n*[screenshot.png]*\n\nAfter')
  })

  it('uses the media resolver for file media nodes', () => {
    const resolveMedia = vi.fn(() => '![shot.png](data:image/png;base64,abc)')
    const markdown = adfToMarkdownText(
      {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'mediaSingle',
            content: [
              {
                type: 'media',
                attrs: { id: 'media-1', type: 'file', alt: 'shot.png' }
              }
            ]
          }
        ]
      },
      { resolveMedia }
    )

    expect(resolveMedia).toHaveBeenCalledWith({
      id: 'media-1',
      url: undefined,
      alt: 'shot.png',
      type: 'file'
    })
    expect(markdown).toBe('![shot.png](data:image/png;base64,abc)')
  })

  it('renders external media URLs without a resolver', () => {
    const markdown = adfToMarkdownText({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'mediaSingle',
          content: [
            {
              type: 'media',
              attrs: {
                type: 'external',
                url: 'https://example.com/diagram.png',
                alt: 'diagram'
              }
            }
          ]
        }
      ]
    })

    expect(markdown).toBe('![diagram](https://example.com/diagram.png)')
  })

  it('renders mediaInline inside paragraphs', () => {
    const markdown = adfToMarkdownText(
      {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'See ' },
              {
                type: 'mediaInline',
                attrs: { id: 'inline-1', type: 'file', alt: 'icon.png' }
              }
            ]
          }
        ]
      },
      {
        resolveMedia: () => '![icon.png](data:image/png;base64,xyz)'
      }
    )

    expect(markdown).toBe('See ![icon.png](data:image/png;base64,xyz)')
  })

  it('escapes markdown-hostile external media destinations', () => {
    const hostile = 'https://cdn.example/x?a=1)![z](https://evil.example/y'
    // Pin: encodeURI alone does not encode )
    expect(encodeURI(hostile)).toContain(')')
    const safe = escapeMarkdownLinkDestination(hostile)
    expect(safe).not.toBeNull()
    expect(safe).not.toContain(')')
    expect(safe).toContain('%29')

    const markdown = adfToMarkdownText({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'mediaSingle',
          content: [{ type: 'media', attrs: { type: 'external', url: hostile, alt: 'Image' } }]
        }
      ]
    })
    expect(markdown).toContain('%29')
    expect(markdown).not.toContain('](https://evil')
  })

  it('preserves existing percent-escapes when encoding destinations', () => {
    const url = 'https://cdn.example/path%20with%20space.png'
    expect(escapeMarkdownLinkDestination(url)).toBe(url)
  })

  it('collects media attrs in document order', () => {
    const attrs = collectAdfMediaAttrs({
      type: 'doc',
      content: [
        { type: 'media', attrs: { id: 'a', alt: 'one.png' } },
        {
          type: 'paragraph',
          content: [{ type: 'mediaInline', attrs: { id: 'b', url: 'https://x.example/y.png' } }]
        }
      ]
    })
    expect(attrs).toEqual([
      { id: 'a', alt: 'one.png' },
      { id: 'b', url: 'https://x.example/y.png' }
    ])
  })
})
