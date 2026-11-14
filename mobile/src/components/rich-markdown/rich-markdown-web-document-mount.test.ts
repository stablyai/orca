// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mountRichMarkdownWebDocument,
  type RichMarkdownWebDocument
} from './rich-markdown-web-document-mount'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

// Prove page mount installs scoped style/markup and fully disposes editor state/listeners before remount (rulings 20/21).
// Browser styling/execCommand behavior belongs to mobile-web-app-rich-markdown-render.test.mjs, not happy-dom.
const mounted: RichMarkdownWebDocument[] = []

function mount(posts: MobileRichMarkdownEditorMessage[] = [], url: string | null = null) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const live = mountRichMarkdownWebDocument(host, {
    postToHost: (message) => posts.push(message),
    promptForUrl: () => Promise.resolve(url)
  })
  mounted.push(live)
  return { host, live, posts }
}

const surfaceIn = (host: HTMLElement) => host.querySelector<HTMLElement>('#editor')

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()!.dispose()
  }
  vi.restoreAllMocks()
})

describe('the editor document mounted in the page', () => {
  it('leaves no listener of the first mount reporting into the second', () => {
    const first = mount()
    const firstSurface = surfaceIn(first.host)!
    first.live.dispose()
    mounted.pop()
    first.posts.length = 0

    const second = mount()
    second.posts.length = 0
    surfaceIn(second.host)!.innerHTML = '<p>second</p>'
    surfaceIn(second.host)!.dispatchEvent(new Event('input', { bubbles: true }))

    expect(second.posts).toEqual([{ type: 'change', markdown: 'second', generation: 0 }])
    // Assert detached surface still receives dispatched events before concluding old listeners are removed.
    firstSurface.innerHTML = '<p>first</p>'
    firstSurface.dispatchEvent(new Event('input', { bubbles: true }))
    expect(first.posts).toEqual([])
  })
})
