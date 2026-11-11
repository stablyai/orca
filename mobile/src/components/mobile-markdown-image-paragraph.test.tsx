import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderImageParagraph } from './mobile-markdown-image-paragraph'
import { mobileMarkdownParagraphImages } from './mobile-markdown-image-placement'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'
import { MARKDOWN_TONES } from './mobile-markdown-styles'
import type { MarkdownBlockContext } from './mobile-markdown-blocks'

vi.mock('react-native', () => ({
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

describe('phone Markdown image paragraphs', () => {
  it.each([100, 1000])('draws %i images with linear eligibility reads', (count) => {
    const root = parseMobileMarkdownTree(
      Array(count).fill('![](/tmp/p.png)').join(' '),
      false,
      true
    )
    const paragraph = root.children[0]!
    if (paragraph.type !== 'paragraph') {
      throw new Error('expected an image paragraph')
    }
    let reads = 0
    const images = mobileMarkdownParagraphImages(paragraph, 0)
    images.forEach((image, index) => {
      Object.defineProperty(images, index, {
        get() {
          reads += 1
          return image
        }
      })
    })
    const drawn: string[] = []
    const ctx: MarkdownBlockContext = {
      onOpenLink: () => {},
      tone: MARKDOWN_TONES.default,
      textScale: 1,
      chatMath: true,
      growing: false,
      listText: {},
      listMarker: {},
      directives: [],
      mermaidOccurrences: new Map(),
      renderImage: (href) => {
        drawn.push(href)
        return createElement('Image', { href })
      }
    }
    expect(
      renderImageParagraph(paragraph.children, images, 0, ctx, {
        style: {},
        selectable: true
      })
    ).not.toBeNull()
    expect(drawn).toEqual(Array(count).fill('/tmp/p.png'))
    // Each eligible image needs one read to index and one to draw, independent of paragraph width.
    expect(reads).toBeLessThanOrEqual(2 * count)
  })
})
