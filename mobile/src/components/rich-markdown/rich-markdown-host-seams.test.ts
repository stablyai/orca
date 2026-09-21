// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { createRichMarkdownEditorScope } from './document-scope'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorDocument, RichMarkdownEditorHost } from './document-host-seams'

/**
 * The six host seams the page sets, and the window reads and writes they default to.
 *
 * The script reached its host through `window.ReactNativeWebView`, asked for a URL with
 * `window.prompt`, measured the keyboard from `visualViewport` and took its ranges, its elements
 * and `execCommand` from the global `document`. On the page none of those means what it means in
 * the WebView: that bridge object is the *shell's*, so an editor message posted through it would
 * put editor JSON into the bridge's own channel; the prompt was measured to return null in both
 * shells, because neither implements the delegate the dialog needs; and the page's screen already
 * measures the same viewport with the same formula, so a second report would lift its bar twice.
 *
 * Both halves are asserted here, because a seam whose default quietly stopped reading the window
 * would leave the native document mute with every other editor test still green — they drive the
 * modules directly and would be stubbing nothing.
 */
const startedDocuments: RichMarkdownEditorDocument[] = []

/** A started document over markup the case owns, with the hooks it wants as the host argument. */
function startedDocument(host: RichMarkdownEditorHost = {}): RichMarkdownEditorDocument {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const started = createRichMarkdownEditorDocument({
    // The one the sequence would otherwise answer with the window: these cases are not the
    // shell's, so nothing observes a viewport unless the case says so.
    keyboardInsetSource: () => null,
    ...host
  })
  startedDocuments.push(started)
  return started
}

afterEach(() => {
  while (startedDocuments.length > 0) {
    startedDocuments.pop()!.stop()
  }
  vi.unstubAllGlobals()
})

describe('the editor document host seams, by default', () => {
  it('posts to the React Native bridge, reading it at call time', () => {
    const postMessage = vi.fn<(data: string) => void>()
    // Built before the global exists: the default must read the window when it posts, not when the
    // scope was created, because the document's scope is built as its script is parsed.
    const scope = createRichMarkdownEditorScope()
    vi.stubGlobal('ReactNativeWebView', { postMessage })
    scope.postToHost({ type: 'ready' })
    expect(postMessage.mock.calls).toEqual([['{"type":"ready"}']])
  })

  it('posts nothing when there is no bridge, which is the guard the script carried', () => {
    expect(() => createRichMarkdownEditorScope().postToHost({ type: 'ready' })).not.toThrow()
  })

  it('asks the window for a URL, under the label each command carried', async () => {
    const prompt = vi.fn<(label?: string) => string | null>(() => 'https://example.com/a')
    const scope = createRichMarkdownEditorScope()
    vi.stubGlobal('prompt', prompt)
    await expect(scope.promptForUrl('link')).resolves.toBe('https://example.com/a')
    await expect(scope.promptForUrl('image')).resolves.toBe('https://example.com/a')
    expect(prompt.mock.calls).toEqual([['Link URL'], ['Image URL']])
  })

  it('answers the cancelled dialog as no URL rather than as a failure', async () => {
    vi.stubGlobal('prompt', () => null)
    await expect(createRichMarkdownEditorScope().promptForUrl('link')).resolves.toBe(null)
  })

  it('measures the covered height from the visual viewport, and observes both its events', () => {
    const listeners: string[] = []
    const removed: string[] = []
    const viewport = {
      height: 500,
      offsetTop: 20,
      addEventListener: (name: string) => listeners.push(name),
      removeEventListener: (name: string) => removed.push(name)
    }
    const scope = createRichMarkdownEditorScope()
    // Null before the viewport exists and a reader after it, which is what "read at call time"
    // means for the one seam whose answer is an object.
    expect(scope.keyboardInsetSource()).toBe(null)
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 800)
    const source = scope.keyboardInsetSource()!
    expect(source.measure()).toBe(280)
    viewport.height = 900
    // Clamped: a viewport taller than the window covers nothing rather than a negative height.
    expect(source.measure()).toBe(0)
    const uninstall = source.observe(() => {})
    expect(listeners).toEqual(['resize', 'scroll'])
    uninstall()
    expect(removed).toEqual(['resize', 'scroll'])
  })

  it('clears a real timer, and a handle that was never set', () => {
    const scope = createRichMarkdownEditorScope()
    const fired = vi.fn()
    vi.useFakeTimers()
    try {
      scope.clearTimer(window.setTimeout(fired, 0))
      vi.runAllTimers()
      expect(fired).not.toHaveBeenCalled()
      expect(() => scope.clearTimer(null)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the selection and the page from the window the document is running in', () => {
    const scope = createRichMarkdownEditorScope()
    expect(scope.getDocument()).toBe(document)
    expect(scope.getSelection()).toBe(window.getSelection())
  })
})

describe('the editor document host seams, once the page sets them', () => {
  it('routes every message to the field and nothing to the bridge', () => {
    const postMessage = vi.fn<(data: string) => void>()
    vi.stubGlobal('ReactNativeWebView', { postMessage })
    const posted: MobileRichMarkdownEditorMessage[] = []
    const started = startedDocument({ postToHost: (message) => posted.push(message) })
    expect(posted).toEqual([{ type: 'ready' }])
    posted.length = 0
    started.send.setEditable(true)
    started.send.setMarkdown('# Title', 3)
    document.getElementById('editor')!.dispatchEvent(new Event('input'))
    expect(posted).toEqual([{ type: 'change', markdown: '# Title', generation: 3 }])
    // The whole reason the seam exists: on the page this object belongs to the shell.
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('takes the URL from the host rather than from a dialog the shell never shows', async () => {
    const commands: [string, boolean, string | undefined][] = []
    const started = startedDocument({
      promptForUrl: (kind) => Promise.resolve(`https://example.com/${kind}`),
      getDocument: () => hostDocument(commands)
    })
    await started.send.runCommand('link')
    await started.send.runCommand('image')
    expect(commands).toEqual([
      ['createLink', false, 'https://example.com/link'],
      ['insertImage', false, 'https://example.com/image']
    ])
  })

  it('reports no inset at all when the host has no source, and observes nothing', () => {
    const posted: MobileRichMarkdownEditorMessage[] = []
    const viewport = {
      height: 500,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 800)
    startedDocument({ keyboardInsetSource: () => null, postToHost: (m) => posted.push(m) })
    expect(posted.map((message) => message.type)).toEqual(['ready'])
    expect(viewport.addEventListener).not.toHaveBeenCalled()
  })

  it('reports the inset from the source the host names, before it reports ready', () => {
    const posted: MobileRichMarkdownEditorMessage[] = []
    startedDocument({
      keyboardInsetSource: () => ({ measure: () => 291.4, observe: () => () => {} }),
      postToHost: (message) => posted.push(message)
    })
    expect(posted).toEqual([{ type: 'keyboardInset', bottom: 291 }, { type: 'ready' }])
  })

  it('takes the caret from the selection the host names, not the window one', async () => {
    // The seam the page needs most. A document mounted inside a screen shares `window` with every
    // other field on it, so the caret the editor saves and restores has to come from the object
    // its host hands over — and the window's must be left alone, because it belongs to whatever
    // else has focus.
    document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
    const editor = document.getElementById('editor')!
    editor.innerHTML = '<p id="only">text</p>'
    const ranges: Range[] = []
    const windowSelection = window.getSelection()!
    windowSelection.removeAllRanges()
    // WebKit's own behaviour, and the reason the document saves a caret at all.
    editor.addEventListener('blur', () => {
      ranges.length = 0
    })

    const hostSelection: Selection = Object.create(windowSelection)
    Object.defineProperty(hostSelection, 'rangeCount', { get: () => ranges.length })
    hostSelection.getRangeAt = (index: number) => ranges[index]!
    hostSelection.removeAllRanges = () => {
      ranges.length = 0
    }
    hostSelection.addRange = (range: Range) => {
      ranges.push(range)
    }

    const caret = document.createRange()
    caret.selectNodeContents(document.getElementById('only')!)
    caret.collapse(true)
    ranges.push(caret)

    const started = createRichMarkdownEditorDocument({
      getSelection: () => hostSelection,
      getDocument: () => hostDocument([]),
      keyboardInsetSource: () => null,
      postToHost: () => {}
    })
    startedDocuments.push(started)

    // Saved out of the host's selection, which the blur then empties.
    editor.focus()
    started.send.dismissKeyboard()
    expect(ranges).toEqual([])
    // And restored into the host's selection rather than the window's.
    await started.send.runCommand('bold')
    expect(
      ranges.map((range) => {
        const container = range.commonAncestorContainer
        return (container instanceof Element ? container : container.parentElement)?.id
      })
    ).toEqual(['only'])
    expect(windowSelection.rangeCount).toBe(0)
  })

  it('runs its selection and its commands against the page the host names', () => {
    const commands: [string, boolean, string | undefined][] = []
    const started = startedDocument({ getDocument: () => hostDocument(commands) })
    started.send.runCommand('bold')
    expect(commands).toEqual([['bold', false, undefined]])
  })
})

/**
 * The page a host hands over: the real one, with `execCommand` recorded.
 *
 * happy-dom implements no `execCommand`, and the point of the seam is that the document never
 * reaches for a global one, so a host that answers with its own is exactly what a case needs.
 */
function hostDocument(commands: [string, boolean, string | undefined][]): Document {
  const page: Document = Object.create(document)
  page.execCommand = (command: string, showUI?: boolean, value?: string) => {
    commands.push([command, showUI === true, value])
    return true
  }
  return page
}
