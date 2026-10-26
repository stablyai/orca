// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorDocument } from './document-host-seams'

// Overlapping session transitions can mount two #editor hosts; document-wide lookup would edit first surface and dispose same listeners.
// Page supplies mount root (seam 7); single-editor native WebView defaults to whole document, matching terminal’s root seam.
const startedDocuments: RichMarkdownEditorDocument[] = []

/** One host element with the document's markup in it, and a document started against it. */
function mountedIn(id: string) {
  const host = document.createElement('div')
  host.id = id
  host.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  document.body.appendChild(host)
  const posts: MobileRichMarkdownEditorMessage[] = []
  const started = createRichMarkdownEditorDocument(
    quietRichMarkdownEditorHost({
      root: host,
      postToHost: (message) => posts.push(message),
      keyboardInsetSource: () => null,
      promptForUrl: () => Promise.resolve(null)
    })
  )
  startedDocuments.push(started)
  return { host, posts, started }
}

/** The editable surface inside one host, by the id the markup gives it. */
function surfaceOf(host: HTMLElement) {
  return host.querySelector<HTMLElement>('#editor')!
}

afterEach(() => {
  while (startedDocuments.length > 0) {
    startedDocuments.pop()!.stop()
  }
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('two editor documents on one page', () => {
  it('writes each host content into that host, and never into the other', () => {
    const first = mountedIn('first')
    const second = mountedIn('second')

    first.started.send.setMarkdown('# first', 1)
    second.started.send.setMarkdown('# second', 1)

    expect(surfaceOf(first.host).textContent).toBe('first')
    expect(surfaceOf(second.host).textContent).toBe('second')
  })

  it('serializes the surface it was started against rather than the page’s first one', () => {
    const first = mountedIn('first')
    const second = mountedIn('second')
    surfaceOf(first.host).innerHTML = '<p>from the first</p>'
    surfaceOf(second.host).innerHTML = '<p>from the second</p>'

    expect(first.started.send.currentMarkdown()).toBe('from the first')
    expect(second.started.send.currentMarkdown()).toBe('from the second')
  })

  it('reports an edit in the second host to the second host’s own host', () => {
    const first = mountedIn('first')
    const second = mountedIn('second')
    first.posts.length = 0
    second.posts.length = 0

    surfaceOf(second.host).innerHTML = '<p>typed</p>'
    surfaceOf(second.host).dispatchEvent(new Event('input', { bubbles: true }))

    expect(second.posts).toEqual([{ type: 'change', markdown: 'typed', generation: 0 }])
    expect(first.posts).toEqual([])
  })

  it('leaves the other document live when one of the two is stopped', () => {
    const first = mountedIn('first')
    const second = mountedIn('second')
    first.started.stop()
    second.posts.length = 0

    surfaceOf(second.host).innerHTML = '<p>still here</p>'
    surfaceOf(second.host).dispatchEvent(new Event('input', { bubbles: true }))

    expect(second.posts).toEqual([{ type: 'change', markdown: 'still here', generation: 0 }])
  })

  it('reads the whole page when no root is named, which is what the WebView gets', () => {
    document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
    const posts: MobileRichMarkdownEditorMessage[] = []
    const started = createRichMarkdownEditorDocument(
      quietRichMarkdownEditorHost({
        postToHost: (message) => posts.push(message),
        keyboardInsetSource: () => null
      })
    )
    startedDocuments.push(started)

    started.send.setMarkdown('# native', 1)

    expect(document.querySelector('#editor')!.textContent).toBe('native')
  })
})
