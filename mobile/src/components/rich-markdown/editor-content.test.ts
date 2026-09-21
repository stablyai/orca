// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorDocument } from './document-host-seams'

/**
 * What the host sets, what it gets back, and the generation that tells the two apart.
 *
 * The host replaces the content while the user is typing into it, so every change carries the
 * generation the content was set under and a reply from before a replacement is one the host can
 * drop. The document's own rewrites are not changes at all, which is what makes a replacement
 * silent rather than a change the host would apply back to itself.
 */
const started: RichMarkdownEditorDocument[] = []

function editorDocument() {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const posted: MobileRichMarkdownEditorMessage[] = []
  const cleared: (number | null)[] = []
  const document_ = createRichMarkdownEditorDocument({
    postToHost: (message) => posted.push(message),
    keyboardInsetSource: () => null,
    clearTimer: (handle) => cleared.push(handle)
  })
  started.push(document_)
  posted.length = 0
  return {
    handle: document_.send,
    posted,
    cleared,
    editor: document.getElementById('editor')!,
    type: () => document.getElementById('editor')!.dispatchEvent(new Event('input'))
  }
}

afterEach(() => {
  while (started.length > 0) {
    started.pop()!.stop()
  }
  document.body.innerHTML = ''
})

describe('the editor document content', () => {
  it('carries the generation it was set under into every change', () => {
    const editor = editorDocument()
    editor.handle.setMarkdown('first', 4)
    editor.type()
    editor.handle.setMarkdown('second', 5)
    editor.type()
    expect(editor.posted).toEqual([
      { type: 'change', markdown: 'first', generation: 4 },
      { type: 'change', markdown: 'second', generation: 5 }
    ])
  })

  it('reads a generation that is not a number as zero', () => {
    const editor = editorDocument()
    editor.handle.setMarkdown('body', Number.NaN)
    editor.type()
    expect(editor.posted).toEqual([{ type: 'change', markdown: 'body', generation: 0 }])
  })

  it('posts the change on the spot, with no timer between the edit and the host', () => {
    // There is no debounce, and the pending handle is cleared before every replacement so that
    // adding one later cannot leak a change from the content it has already replaced.
    const editor = editorDocument()
    vi.useFakeTimers()
    try {
      editor.handle.setMarkdown('body', 1)
      editor.type()
      expect(editor.posted).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    expect(editor.cleared).toEqual([null, null])
  })

  it('says nothing while it is rewriting itself', () => {
    // `setMarkdown` replaces the markup, which a live browser reports as input; a change posted
    // from it would send the host back the content the host just set.
    const editor = editorDocument()
    editor.handle.setMarkdown('# Title', 2)
    expect(editor.posted).toEqual([])
    expect(editor.editor.innerHTML).toBe('<h1>Title</h1>')
  })

  it('stops reporting, and disables every checkbox, once it is read-only', () => {
    const editor = editorDocument()
    editor.handle.setMarkdown('- [ ] Open\n- [x] Done', 1)
    editor.handle.setEditable(false)
    expect(editor.editor.getAttribute('contenteditable')).toBe('false')
    expect(
      Array.from(editor.editor.querySelectorAll('input')).map((input) => input.disabled)
    ).toEqual([true, true])
    editor.type()
    expect(editor.posted).toEqual([])

    editor.handle.setEditable(true)
    expect(
      Array.from(editor.editor.querySelectorAll('input')).map((input) => input.disabled)
    ).toEqual([false, false])
    editor.type()
    expect(editor.posted).toEqual([
      { type: 'change', markdown: '- [ ] Open\n- [x] Done', generation: 1 }
    ])
  })

  it('writes a ticked checkbox back into the markup the next serialization reads', () => {
    const editor = editorDocument()
    editor.handle.setMarkdown('- [ ] Open', 1)
    const checkbox = editor.editor.querySelector('input')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    expect(editor.editor.querySelector('li')!.getAttribute('data-checked')).toBe('true')
    expect(editor.posted).toEqual([{ type: 'change', markdown: '- [x] Open', generation: 1 }])
  })
})
