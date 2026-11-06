import { describe, expect, it } from 'vitest'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'

const blocks = (source: string) => parseMobileMarkdownTree(source, false).children

describe('GitHub syntax in mobile Markdown', () => {
  it('reads an alert and drops its marker line', () => {
    expect(blocks('> [!WARNING]\n> Back up first.')).toEqual([
      {
        type: 'blockquote',
        data: { callout: 'warning' },
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Back up first.' }] }]
      }
    ])
  })

  it('keeps a marker sharing its line with text as a plain quote, as GitHub does', () => {
    expect(blocks('> [!NOTE] aside')[0]).not.toHaveProperty('data')
  })

  it('draws the inline tags GitHub allows and keeps only the text of others', () => {
    expect(
      blocks('H<sub>2</sub>O, <kbd>Ctrl</kbd>, <b>bold</b>, <del>gone</del>, <u>u</u>')
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'H' },
          { type: 'htmlSpan', tag: 'sub', children: [{ type: 'text', value: '2' }] },
          { type: 'text', value: 'O, ' },
          { type: 'htmlSpan', tag: 'kbd', children: [{ type: 'text', value: 'Ctrl' }] },
          { type: 'text', value: ', ' },
          { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
          { type: 'text', value: ', ' },
          { type: 'delete', children: [{ type: 'text', value: 'gone' }] },
          { type: 'text', value: ', ' },
          { type: 'text', value: 'u' }
        ]
      }
    ])
  })

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

  it('keeps linked badges, percentage widths and commented images as before', () => {
    expect(
      blocks(
        '<a href="https://ci.example/run"><img src="https://img.shields.io/ci.svg" alt="CI"></a>\n\n' +
          '<!-- like <img src="https://example.com/x.png"> -->\n\n' +
          '<img width="50%" src="https://example.com/half.png" alt="half">'
      )
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            url: 'https://ci.example/run',
            children: [{ type: 'image', url: 'https://img.shields.io/ci.svg', alt: 'CI' }]
          }
        ]
      },
      {
        type: 'paragraph',
        children: [{ type: 'image', url: 'https://example.com/half.png', alt: 'half' }]
      }
    ])
  })

  it('keeps an image inside a heading in its heading and reads a link href as HTML does', () => {
    const [heading, link] = blocks(
      '<h1 align="center"><img src="https://example.com/logo.png" width="120"><br>Project</h1>\n\n' +
        '<a title="see href=javascript:x" href="https://x.com/?a=1&amp;b=2">compare</a>'
    )
    expect(heading).toMatchObject({ type: 'heading', depth: 1 })
    expect(link).toMatchObject({
      type: 'paragraph',
      children: [{ type: 'link', url: 'https://x.com/?a=1&b=2' }]
    })
  })
})
