// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorDocument, RichMarkdownEditorHost } from './document-host-seams'

// Page supplies messages, URL prompt and keyboard seams: shell owns ReactNativeWebView, window.prompt returns null, and screen already measures keyboard; test remaining live-window defaults.
const startedDocuments: RichMarkdownEditorDocument[] = []

/** A started document over markup the case owns, with the hooks it wants as the host argument. */
function startedDocument(host: Partial<RichMarkdownEditorHost> = {}): RichMarkdownEditorDocument {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const started = createRichMarkdownEditorDocument(quietRichMarkdownEditorHost(host))
  startedDocuments.push(started)
  return started
}

afterEach(() => {
  while (startedDocuments.length > 0) {
    startedDocuments.pop()!.stop()
  }
  vi.unstubAllGlobals()
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
    // Save/restore only host selection: overlapping fields share window, and global selection belongs to whichever other field holds focus.
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

    const started = createRichMarkdownEditorDocument(
      quietRichMarkdownEditorHost({
        getSelection: () => hostSelection,
        getDocument: () => hostDocument([]),
        keyboardInsetSource: () => null,
        postToHost: () => {}
      })
    )
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

// Host supplies real document with recorded execCommand because happy-dom lacks it; prove no global command lookup.
function hostDocument(commands: [string, boolean, string | undefined][]): Document {
  const page: Document = Object.create(document)
  page.execCommand = (command: string, showUI?: boolean, value?: string) => {
    commands.push([command, showUI === true, value])
    return true
  }
  return page
}
