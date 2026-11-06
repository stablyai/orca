import { describe, expect, it } from 'vitest'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'

const blocks = (source: string) => parseMobileMarkdownTree(source, false).children

describe('GitHub syntax in mobile Markdown', () => {
  it('draws an https <img> at its authored width and leaves icons out', () => {
    expect(
      blocks(
        '<p align="center"><img width="300" alt="shot" src="https://example.com/a.png"></p>\n\n' +
          'Minor <img src="https://example.com/icon.svg" width="16" alt="">'
      )
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'image', url: 'https://example.com/a.png', alt: 'shot', data: { width: 300 } }
        ]
      },
      { type: 'paragraph', children: [{ type: 'text', value: 'Minor ' }] }
    ])
  })
})
