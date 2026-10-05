// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createRichMarkdownEditorScope } from './document-scope'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { currentMarkdown, setMarkdown } from './editor-content'
import { setImageSources } from './editor-image-sources'
import { startEditorSurface } from './editor-surface'

function surface(markdown: string) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const scope = createRichMarkdownEditorScope()
  startEditorSurface(scope)
  setMarkdown(scope, markdown, 1)
  const editor = document.getElementById('editor')!
  return { scope, editor }
}

describe('image sources on the editor surface', () => {
  it('renders the authored src into both slots before the host resolves anything', () => {
    const { editor } = surface('![Shot](docs/a.png)')
    const image = editor.querySelector('img')!
    expect(image.getAttribute('data-orca-src')).toBe('docs/a.png')
    expect(image.getAttribute('src')).toBe('docs/a.png')
  })

  it('swaps only the display slot, so serialization keeps the authored src', () => {
    const { scope, editor } = surface('![Shot](docs/a.png) ![Two](img/b.png)')
    setImageSources(scope, { 'docs/a.png': 'data:image/png;base64,QUJD' })
    const images = Array.from(editor.querySelectorAll('img'))
    expect(images[0]!.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    expect(images[0]!.getAttribute('data-orca-src')).toBe('docs/a.png')
    // No entry for the second image leaves its authored src in place.
    expect(images[1]!.getAttribute('src')).toBe('img/b.png')
    expect(currentMarkdown(scope)).toBe('![Shot](docs/a.png) ![Two](img/b.png)')
  })

  it('re-applies the stored sources after a content replacement rebuilds the surface', () => {
    const { scope, editor } = surface('![Shot](docs/a.png)')
    setImageSources(scope, { 'docs/a.png': 'data:image/png;base64,QUJD' })
    setMarkdown(scope, '![Shot](docs/a.png)', 2)
    expect(editor.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    expect(currentMarkdown(scope)).toBe('![Shot](docs/a.png)')
  })

  it('does not blank the display slot for an empty map entry', () => {
    const { scope, editor } = surface('![Shot](docs/a.png)')
    setImageSources(scope, { 'docs/a.png': '' })
    expect(editor.querySelector('img')!.getAttribute('src')).toBe('docs/a.png')
  })

  it('restores authored sources when a replacement map omits an old image', () => {
    const { scope, editor } = surface('![Shot](docs/a.png)')
    setImageSources(scope, { 'docs/a.png': 'data:image/png;base64,QUJD' })
    setImageSources(scope, {})
    expect(editor.querySelector('img')!.getAttribute('src')).toBe('docs/a.png')
    expect(currentMarkdown(scope)).toBe('![Shot](docs/a.png)')
  })

  it('serves an image the user inserted afterwards from its own src', () => {
    const { scope, editor } = surface('text')
    const inserted = document.createElement('img')
    inserted.setAttribute('src', 'https://example.com/new.png')
    editor.querySelector('p')!.append(inserted)
    setImageSources(scope, { 'docs/a.png': 'data:image/png;base64,QUJD' })
    expect(inserted.getAttribute('src')).toBe('https://example.com/new.png')
    expect(currentMarkdown(scope)).toContain('https://example.com/new.png')
  })
})
