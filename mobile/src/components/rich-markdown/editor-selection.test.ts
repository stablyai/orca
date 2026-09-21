// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { RichMarkdownEditorDocument } from './document-host-seams'

/**
 * The caret across a keyboard dismissal, which is the document's hardest piece of state.
 *
 * WebKit discards the DOM selection on blur, so the document saves the caret before it blurs
 * itself and restores it the next time a command needs one. Without that, every toolbar press
 * after the keyboard closed would insert at the end of the document instead of where the user was.
 *
 * The blur below drops the ranges, which is the whole point: a case over a browser that keeps them
 * would pass whatever the document did.
 */
const started: RichMarkdownEditorDocument[] = []

function runtime(options: { caret?: 'paragraph-3' | null } = {}) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const editor = document.getElementById('editor')!
  editor.innerHTML =
    '<p id="paragraph-3">three</p><p id="paragraph-7">seven</p>' +
    '<p><label id="task-label" contenteditable="false">label</label></p>'
  // WebKit's own behaviour, and the reason the saved range exists.
  editor.addEventListener('blur', () => window.getSelection()?.removeAllRanges())
  // The selection outlives the markup, so a case starts from none rather than from the last one's.
  window.getSelection()?.removeAllRanges()

  let caretAt: string | null = null
  const caretRangeFromPoint = () => {
    const node = caretAt === null ? null : document.getElementById(caretAt)
    if (!node) {
      return null
    }
    const range = document.createRange()
    range.selectNodeContents(node)
    range.collapse(true)
    return range
  }
  Object.defineProperty(document, 'caretRangeFromPoint', {
    value: caretRangeFromPoint,
    configurable: true
  })
  // happy-dom implements no `execCommand`; what these cases read is the caret it would act on.
  Object.defineProperty(document, 'execCommand', { value: () => true, configurable: true })

  const document_ = createRichMarkdownEditorDocument({
    postToHost: () => {},
    keyboardInsetSource: () => null
  })
  started.push(document_)

  if (options.caret) {
    const range = document.createRange()
    range.selectNodeContents(document.getElementById(options.caret)!)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
  }

  return {
    handle: document_.send,
    tapAt: (target: string) => {
      caretAt = target
      document.getElementById(target)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    },
    detachContent: () => {
      editor.innerHTML = '<p>replaced</p>'
    },
    focused: () => document.activeElement === editor,
    selectedContainer: () => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) {
        return null
      }
      const container = selection.getRangeAt(0).commonAncestorContainer
      if (container === editor) {
        return 'editor-end'
      }
      const element = container instanceof Element ? container : container.parentElement
      return element?.id ?? null
    }
  }
}

afterEach(() => {
  while (started.length > 0) {
    started.pop()!.stop()
  }
  Reflect.deleteProperty(document, 'caretRangeFromPoint')
  Reflect.deleteProperty(document, 'execCommand')
  document.body.innerHTML = ''
})

describe('the editor document caret, across a keyboard dismissal', () => {
  it('blurs the surface, which is what closes the keyboard over a document', () => {
    const editor = runtime({ caret: 'paragraph-3' })
    expect(editor.focused()).toBe(true)
    editor.handle.dismissKeyboard()
    expect(editor.focused()).toBe(false)
    expect(editor.selectedContainer()).toBe(null)
  })

  it('reclaims focus at the tapped caret rather than at the stale one', () => {
    const editor = runtime({ caret: 'paragraph-3' })
    editor.handle.dismissKeyboard()
    editor.tapAt('paragraph-7')
    expect(editor.focused()).toBe(true)
    expect(editor.selectedContainer()).toBe('paragraph-7')
  })

  it('leaves an uneditable label tap to the checkbox instead of refocusing', () => {
    // A task-list label forwards its click to the checkbox, so refocusing here would steal it and
    // re-open the keyboard the user just dismissed.
    const editor = runtime({ caret: 'paragraph-3' })
    editor.handle.dismissKeyboard()
    editor.tapAt('task-label')
    expect(editor.focused()).toBe(false)
    expect(editor.selectedContainer()).toBe(null)
  })

  it('restores the pre-dismissal caret so a command does not insert at the end', async () => {
    const editor = runtime({ caret: 'paragraph-3' })
    editor.handle.dismissKeyboard()
    expect(editor.selectedContainer()).toBe(null)
    await editor.handle.runCommand('bold')
    expect(editor.selectedContainer()).toBe('paragraph-3')
    expect(editor.focused()).toBe(true)
  })

  it('falls back to the end of the document when no caret was ever placed', async () => {
    const editor = runtime({ caret: null })
    await editor.handle.runCommand('bold')
    expect(editor.selectedContainer()).toBe('editor-end')
  })

  it('drops a remembered caret whose nodes left the document', async () => {
    const editor = runtime({ caret: 'paragraph-3' })
    editor.handle.dismissKeyboard()
    editor.detachContent()
    await editor.handle.runCommand('bold')
    expect(editor.selectedContainer()).toBe('editor-end')
  })
})
