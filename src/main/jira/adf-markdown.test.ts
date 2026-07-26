import { describe, expect, it, vi } from 'vitest'
import { adfToMarkdownText, collectAdfMediaAttrs } from './adf-markdown'
import { escapeMarkdownLinkDestination } from './adf-media-destination'

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
