// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'

import type { RichMarkdownEditorDocument } from './document-host-seams'

// Page supplies messages, URL prompt and keyboard seams: shell owns ReactNativeWebView, window.prompt returns null, and screen already measures keyboard; test remaining live-window defaults.
const startedDocuments: RichMarkdownEditorDocument[] = []

afterEach(() => {
  while (startedDocuments.length > 0) {
    startedDocuments.pop()!.stop()
  }
  vi.unstubAllGlobals()
})

describe('the editor document host seams, once the page sets them', () => {
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
