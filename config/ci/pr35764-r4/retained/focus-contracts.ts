import { fireEvent, render } from '@testing-library/react'
import { Editor, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Plugin } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { RichMarkdownToolbar } from '@/components/editor/RichMarkdownToolbar'
import { focusRichMarkdownEditorFromSearch } from '@/components/editor/rich-markdown-search-focus'
import { createSurface, findTextPosition } from './editor-surface'

export function registerFocusContracts() {
  it('formats the deliberate model selection while Find owns focus', () => {
    vi.useFakeTimers()
    const { editor, input } = createSurface('<p>first</p><p>lower caret</p>')
    const toolbar = render(
      createElement(RichMarkdownToolbar, {
        editor,
        onToggleLink: vi.fn(),
        onImagePick: vi.fn()
      })
    )
    try {
      editor.view.focus()
      const text = editor.view.dom.querySelector('p:last-child')?.firstChild
      if (!text) {
        throw new Error('Expected editor text')
      }
      document.getSelection()?.setBaseAndExtent(text, 2, text, 7)
      input.focus()
      // Explicit Find navigation changes the model while the input owns the native selection.
      editor.commands.setTextSelection({ from: 1, to: 6 })
      const bold = toolbar.getByRole('button', { name: 'Bold' })
      fireEvent.mouseDown(bold, { button: 0 })
      fireEvent.click(bold)
      expect(editor.view.dom.querySelector('strong')?.textContent).toBe('first')
      expect(editor.view.dom.querySelector('p:last-child')?.textContent).toBe('lower caret')
    } finally {
      toolbar.unmount()
      editor.destroy()
    }
  })

  it.each(['find', 'replace'] as const)(
    'publishes undelivered native selections before %s takes focus and before immediate copy',
    (field) => {
      const { editor, input, replace } = createSurface('<p>first</p><p>lower caret</p>')
      const text = editor.view.dom.querySelector('p:last-child')?.firstChild
      if (!text) {
        throw new Error('Expected lower paragraph text')
      }
      const lower = findTextPosition(editor, 'lower caret')
      try {
        editor.view.focus()
        const updates = vi.fn()
        editor.on('update', updates)
        const doc = editor.state.doc
        for (const [anchor, head] of [
          [2, 7],
          [7, 2],
          [6, 6]
        ]) {
          document.getSelection()?.setBaseAndExtent(text, anchor, text, head)
          // No selectionchange is delivered before the direct focus transfer.
          ;(field === 'find' ? input : replace).focus()
          expect(editor.state.selection.anchor).toBe(lower + anchor)
          expect(editor.state.selection.head).toBe(lower + head)
          editor.view.focus()
          expect(document.getSelection()?.anchorOffset).toBe(anchor)
          expect(document.getSelection()?.focusOffset).toBe(head)
        }
        document.getSelection()?.setBaseAndExtent(text, 7, text, 2)
        editor.view.dom.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }))
        expect(editor.state.selection.anchor).toBe(lower + 7)
        expect(editor.state.selection.head).toBe(lower + 2)
        expect(editor.state.doc).toBe(doc)
        expect(updates).not.toHaveBeenCalled()
      } finally {
        editor.destroy()
      }
    }
  )

  it.each(['find', 'replace'] as const)(
    'restores the anchor before editor pointer handling from %s',
    (field) => {
      vi.useFakeTimers()
      const { editor, input, replace } = createSurface('<p>first</p><p>lower caret</p>')
      const caret = findTextPosition(editor, 'lower caret') + 6
      const updates = vi.fn()
      editor.on('update', updates)
      try {
        editor.commands.setTextSelection(caret)
        ;(field === 'find' ? input : replace).focus()
        document.getSelection()?.removeAllRanges()
        const paragraph = editor.view.dom.querySelector('p:last-child')
        const text = paragraph?.firstChild
        if (!paragraph || !text) {
          throw new Error('Expected lower paragraph text')
        }
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: caret, inside: -1 })
        const beforePointer = vi.fn(() => ({
          focused: document.activeElement === editor.view.dom,
          anchor: document.getSelection()?.anchorNode,
          offset: document.getSelection()?.anchorOffset
        }))
        editor.registerPlugin(
          new Plugin({
            props: {
              handleDOMEvents: {
                mousedown: () => {
                  beforePointer()
                  return false
                }
              }
            }
          })
        )
        const originalDoc = editor.state.doc
        const selection = editor.state.selection
        const event = new MouseEvent('mousedown', {
          button: 0,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })

        paragraph.dispatchEvent(event)

        expect(beforePointer).toHaveReturnedWith({ focused: true, anchor: text, offset: 6 })
        expect(document.activeElement).toBe(editor.view.dom)
        expect(document.getSelection()?.anchorNode).toBe(text)
        expect(document.getSelection()?.anchorOffset).toBe(6)
        expect(document.getSelection()?.focusOffset).toBe(6)
        expect(event.defaultPrevented).toBe(false)

        vi.advanceTimersByTime(20)

        expect(editor.state.selection).toBe(selection)
        expect(editor.state.doc).toBe(originalDoc)
        expect(updates).not.toHaveBeenCalled()
      } finally {
        editor.destroy()
      }
    }
  )

  it('focuses a handled cross-cell selection and preserves its cells without marking content dirty', () => {
    vi.useFakeTimers()
    const { editor, input } = createSurface(
      '<table><tbody><tr><td>first</td><td>second</td></tr></tbody></table>'
    )
    const updates = vi.fn()
    try {
      editor.commands.setTextSelection(findTextPosition(editor, 'first'))
      editor.on('update', updates)
      input.focus()
      const secondPos = findTextPosition(editor, 'second')
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: secondPos, inside: secondPos })
      const second = editor.view.dom.querySelector('td:last-child p')
      if (!second) {
        throw new Error('Expected second table cell')
      }
      const originalDoc = editor.state.doc
      const event = new MouseEvent('mousedown', {
        button: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })

      second.dispatchEvent(event)

      const selection = editor.state.selection
      expect(selection).toBeInstanceOf(CellSelection)
      expect(selection).toEqual(
        CellSelection.create(
          editor.state.doc,
          findTextPosition(editor, 'first') - 2,
          findTextPosition(editor, 'second') - 2
        )
      )
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(editor.view.dom)
      expect(editor.view.dom.querySelectorAll('.selectedCell')).toHaveLength(2)
      expect(editor.view.dom.classList.contains('ProseMirror-hideselection')).toBe(true)
      expect(document.getSelection()?.rangeCount).toBe(1)

      vi.advanceTimersByTime(20)

      expect(editor.state.selection).toBe(selection)
      expect(editor.state.doc).toBe(originalDoc)
      expect(updates).not.toHaveBeenCalled()
      expect(editor.view.dom.querySelectorAll('.selectedCell')).toHaveLength(2)
    } finally {
      editor.destroy()
    }
  })
  it('leaves a NodeView that stops pointer events in charge of focus', () => {
    const root = document.createElement('div')
    root.className = 'rich-markdown-editor-shell'
    const search = document.createElement('div')
    search.className = 'rich-markdown-search'
    const input = document.createElement('input')
    search.append(input)
    document.body.append(root)
    const handoff = vi.fn(focusRichMarkdownEditorFromSearch)
    const editor = new Editor({
      extensions: [
        StarterKit,
        Node.create({
          name: 'pointerControl',
          group: 'block',
          atom: true,
          parseHTML: () => [{ tag: 'section' }],
          renderHTML: () => ['section'],
          addNodeView: () => () => ({
            dom: document.createElement('section'),
            stopEvent: () => true
          })
        })
      ],
      content: '<section></section>',
      editorProps: {
        handleDOMEvents: {
          mousedown: (view, event) => {
            handoff(event, view)
            return false
          }
        }
      }
    })
    root.append(editor.view.dom, search)
    try {
      input.focus()
      editor.view.dom
        .querySelector('section')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      expect(handoff).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(input)
    } finally {
      editor.destroy()
    }
  })
}
