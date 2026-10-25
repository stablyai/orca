// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RICH_MARKDOWN_HOST_CLASS,
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
  it('plants the markup in the host and reports itself ready through the seam', () => {
    const { host, posts } = mount()
    expect(surfaceIn(host)?.getAttribute('contenteditable')).toBe('true')
    expect(posts).toEqual([{ type: 'ready' }])
    // Never the shell's bridge: on the page that object is the host's own channel.
    expect(window.ReactNativeWebView).toBeUndefined()
  })

  it('never reports a keyboard inset, because the screen measures the same viewport', () => {
    // No keyboard source means no observer/report; duplicate viewport measurement would double-lift screen bar.
    const { posts } = mount()
    window.dispatchEvent(new Event('resize'))
    expect(posts.filter((message) => message.type === 'keyboardInset')).toEqual([])
  })

  it('injects one sheet for the page, held entirely under the host class', () => {
    mount()
    mount()
    const sheets = document.querySelectorAll('#orca-rich-markdown-document-style')
    expect(sheets).toHaveLength(1)
    const text = sheets[0]!.textContent ?? ''
    const selectors = [...text.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].flatMap((match) =>
      match[1]!.split(',').map((one) => one.trim())
    )
    expect(selectors.length).toBeGreaterThan(0)
    const prefix = `.${RICH_MARKDOWN_HOST_CLASS}`
    expect(selectors.filter((one) => one !== prefix && !one.startsWith(`${prefix} `))).toEqual([])
  })

  it('gives the host back on dispose, so every rule of the sheet matches nothing', () => {
    const { host, live } = mount()
    expect(host.classList.contains(RICH_MARKDOWN_HOST_CLASS)).toBe(true)
    live.dispose()
    mounted.pop()
    expect(host.innerHTML).toBe('')
    expect(host.classList.contains(RICH_MARKDOWN_HOST_CLASS)).toBe(false)
  })

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

  it('gives the host back when the document fails to start, rather than leaving a dead one', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    // Fail at actual surface lookup so factory’s partial-start unwind stays real.
    vi.spyOn(host, 'querySelector').mockReturnValue(null)

    expect(() =>
      mountRichMarkdownWebDocument(host, {
        postToHost: () => {},
        promptForUrl: () => Promise.resolve(null)
      })
    ).toThrow()
    expect(host.innerHTML).toBe('')
    expect(host.classList.contains(RICH_MARKDOWN_HOST_CLASS)).toBe(false)
  })

  it('answers the URL commands from the host rather than from a dialog the shell never shows', async () => {
    // Record host URL reaching execCommand; real browser rig verifies command result because happy-dom has no implementation.
    const executed: [string, string | undefined][] = []
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string, _ui: boolean, value?: string) => {
        executed.push([command, value])
        return true
      }
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const promptForUrl = vi.fn(() => Promise.resolve('https://example.com/a'))
    const live = mountRichMarkdownWebDocument(host, { postToHost: () => {}, promptForUrl })
    mounted.push(live)

    await live.send.runCommand('image')

    expect(promptForUrl.mock.calls).toEqual([['image']])
    expect(executed).toContainEqual(['insertImage', 'https://example.com/a'])
  })

  it('runs nothing when the host cancels, which is what the shell used to do for every URL', async () => {
    const executed: string[] = []
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string) => {
        executed.push(command)
        return true
      }
    })
    const { live } = mount([], null)
    await live.send.runCommand('link')
    expect(executed).toEqual([])
  })
})
