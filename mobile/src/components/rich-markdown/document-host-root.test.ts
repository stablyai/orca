// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorDocument } from './document-host-seams'

/**
 * Two editor documents on one page, each reading the surface its own host carries.
 *
 * The markup gives the surface an id, and inside the WebView that is unambiguous because the
 * document *is* the page. On the page it is not: a stack transition keeps the outgoing session
 * screen mounted while the incoming one starts, so two hosts carry `#editor` at once and a
 * page-wide read hands both documents whichever came first in the tree. The second editor then
 * types into the first, and stopping either takes the listeners off the same element.
 *
 * So the root is the seventh seam, exactly as it is the terminal's ninth: the WebView names none
 * of them and gets the whole page, and the page names the element the mount planted the markup in.
 */
const startedDocuments: RichMarkdownEditorDocument[] = []

/** One host element with the document's markup in it, and a document started against it. */
function mountedIn(id: string) {
  const host = document.createElement('div')
  host.id = id
  host.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  document.body.appendChild(host)
  const posts: MobileRichMarkdownEditorMessage[] = []
  const started = createRichMarkdownEditorDocument({
    root: host,
    postToHost: (message) => posts.push(message),
    keyboardInsetSource: () => null,
    promptForUrl: () => Promise.resolve(null)
  })
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
    const started = createRichMarkdownEditorDocument({
      postToHost: (message) => posts.push(message),
      keyboardInsetSource: () => null
    })
    startedDocuments.push(started)

    started.send.setMarkdown('# native', 1)

    expect(document.querySelector('#editor')!.textContent).toBe('native')
  })
})
