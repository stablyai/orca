// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorDocument } from './document-host-seams'

// Round-trip host generation unchanged so pre-replacement changes can be discarded; suppress document’s own rewrites to avoid echo.
const started: RichMarkdownEditorDocument[] = []

function editorDocument() {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const posted: MobileRichMarkdownEditorMessage[] = []
  const document_ = createRichMarkdownEditorDocument(
    quietRichMarkdownEditorHost({
      postToHost: (message) => posted.push(message),
      keyboardInsetSource: () => null
    })
  )
  started.push(document_)
  posted.length = 0
  return {
    handle: document_.send,
    posted,
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
  })

  it('says nothing while it is rewriting itself', () => {
    // setMarkdown’s DOM rewrite must not echo host’s content as new user change.
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

  it('reports one change for a checkbox tap, not one per event the tap raises', () => {
    // Assert click/input/change all bubble for one tick, then prove only one report; missing events cannot satisfy count accidentally.
    const editor = editorDocument()
    editor.handle.setMarkdown('- [ ] Open', 1)
    const reached: string[] = []
    for (const name of ['click', 'input', 'change']) {
      editor.editor.addEventListener(name, (event) => reached.push(event.type))
    }
    editor.editor.querySelector('input')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(reached).toEqual(['click', 'input', 'change'])
    expect(editor.editor.querySelector('li')!.getAttribute('data-checked')).toBe('true')
    expect(editor.posted).toEqual([{ type: 'change', markdown: '- [x] Open', generation: 1 }])
  })

  it('reports one change for inline code over a selection, not one per emitting step', async () => {
    // The wrap helper emitted and `runCommand` emits after every command: two identical changes.
    const editor = editorDocument()
    editor.handle.setMarkdown('one two', 1)
    const text = editor.editor.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 3)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await editor.handle.runCommand('inlineCode')
    expect(editor.editor.innerHTML).toBe('<p><code>one</code> two</p>')
    expect(editor.posted).toEqual([{ type: 'change', markdown: '`one` two', generation: 1 }])
  })
})
