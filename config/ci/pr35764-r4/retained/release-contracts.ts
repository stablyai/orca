import { fireEvent } from '@testing-library/react'
import { Node, type Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
import { createSurface } from './editor-surface'

export function registerReleaseContracts() {
  it.each([
    { table: false, terminal: 'mouseup', anchor: 2, head: 7 },
    { table: true, terminal: 'mouseup', anchor: 7, head: 2 },
    { table: false, terminal: 'mousemove', anchor: 7, head: 2 }
  ])(
    'settles the real engine release writer ($terminal, table=$table)',
    ({ table, terminal, anchor, head }) => {
      vi.useFakeTimers()
      const { editor } = createSurface(
        table
          ? '<table><tbody><tr><td>lower caret</td><td>other cell</td></tr></tbody></table>'
          : '<p>lower caret</p>'
      )
      const text = editor.view.dom.querySelector('p')?.firstChild
      if (!text) {
        throw new Error('Expected native text')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect the pinned engine's actual tracker/observer; never replace its done or delayed writer.
      const engine = editor.view as Editor['view'] & {
        input: {
          mouseDown: { allowDefault: boolean; delayedSelectionSync: boolean; done(): void } | null
        }
        domObserver: { flushSoon(): void }
      }
      try {
        editor.view.focus()
        editor.commands.setTextSelection(editor.view.posAtDOM(text, 0))
        vi.runAllTimers()
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
          pos: editor.state.selection.from,
          inside: -1
        })
        fireEvent.mouseDown(text.parentElement ?? editor.view.dom, {
          button: 0,
          buttons: 1,
          shiftKey: true
        })
        const tracker = engine.input.mouseDown
        if (!tracker) {
          throw new Error('Expected real native engine tracker')
        }
        expect(tracker.allowDefault).toBe(true)
        const done = vi.spyOn(tracker, 'done')
        const mappings = vi.spyOn(editor.view, 'posAtDOM')
        fireEvent.mouseMove(document, { buttons: 1 })
        expect(mappings).not.toHaveBeenCalled()
        const native = document.getSelection()
        if (!native) {
          throw new Error('Expected native selection')
        }
        native.setBaseAndExtent(text, anchor, text, head)
        document.dispatchEvent(new Event('selectionchange'))
        expect(editor.state.selection.empty).toBe(true)
        engine.domObserver.flushSoon()
        const publications = vi.fn()
        editor.on('selectionUpdate', publications)
        const restore = vi.spyOn(native, 'setBaseAndExtent')
        const writes = [
          vi.spyOn(native, 'collapse'),
          vi.spyOn(native, 'extend'),
          vi.spyOn(native, 'addRange'),
          vi.spyOn(native, 'removeAllRanges')
        ]
        document.dispatchEvent(new MouseEvent(terminal, { button: 0, buttons: 0, bubbles: true }))
        expect(done).toHaveBeenCalledOnce()
        expect(engine.input.mouseDown).toBeNull()
        expect(tracker.delayedSelectionSync).toBe(true)
        expect(publications).toHaveBeenCalledOnce()
        expect(restore).toHaveBeenCalledOnce()
        expect(editor.state.selection.anchor).toBe(editor.view.posAtDOM(text, anchor))
        expect(editor.state.selection.head).toBe(editor.view.posAtDOM(text, head))
        // Equivalent text endpoints allow one restoration; immediate and delayed engine writers must do nothing.
        document.dispatchEvent(new Event('selectionchange'))
        vi.runAllTimers()
        expect(writes.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
        expect(
          [restore, ...writes].reduce((total, write) => total + write.mock.calls.length, 0)
        ).toBe(1)
        expect(restore).toHaveBeenCalledOnce()
        expect(publications).toHaveBeenCalledOnce()
        expect(native.anchorNode).toBe(text)
        expect(native.focusNode).toBe(text)
        expect(native.anchorOffset).toBe(anchor)
        expect(native.focusOffset).toBe(head)
        // Teardown with a fresh real delayed engine writer still outstanding.
        fireEvent.mouseDown(text.parentElement ?? editor.view.dom, {
          clientX: 1000,
          clientY: 1000,
          button: 0,
          buttons: 1,
          shiftKey: true
        })
        const teardownTracker = engine.input.mouseDown
        if (!teardownTracker) {
          throw new Error('Expected teardown gesture tracker')
        }
        native.setBaseAndExtent(text, head, text, anchor)
        document.dispatchEvent(new Event('selectionchange'))
        restore.mockClear()
        writes.forEach((write) => write.mockClear())
        fireEvent.mouseUp(document, { button: 0 })
        expect(teardownTracker.delayedSelectionSync).toBe(true)
        editor.destroy()
        document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))
        document.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }))
        vi.runAllTimers()
        expect(writes.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
        expect(restore).toHaveBeenCalledOnce()
        expect(
          [restore, ...writes].reduce((total, write) => total + write.mock.calls.length, 0)
        ).toBe(1)
      } finally {
        editor.destroy()
      }
    }
  )

  it.each(['find', 'replace', 'control', 'return-before-release'] as const)(
    'does not import another focus owner’s editor-contained fallback on release (%s)',
    (owner) => {
      vi.useFakeTimers()
      const controlNode = Node.create({
        name: 'releaseControl',
        group: 'block',
        atom: true,
        parseHTML: () => [{ tag: 'section' }],
        renderHTML: () => ['section'],
        addNodeView: () => () => {
          const dom = document.createElement('section')
          const input = document.createElement('input')
          dom.append(input)
          return { dom, stopEvent: () => true }
        }
      })
      const { editor, input, replace } = createSurface('<p>lower caret</p><section></section>', [
        controlNode
      ])
      const text = editor.view.dom.querySelector('p')?.firstChild
      const control = editor.view.dom.querySelector('section input')
      if (!text || !(control instanceof HTMLInputElement)) {
        throw new Error('Expected text and stopped control')
      }
      try {
        editor.view.focus()
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: -1 })
        fireEvent.mouseDown(text.parentElement ?? editor.view.dom, {
          button: 0,
          buttons: 1,
          shiftKey: true
        })
        document.getSelection()?.setBaseAndExtent(text, 2, text, 7)
        document.dispatchEvent(new Event('selectionchange'))
        const destination = owner === 'control' ? control : owner === 'replace' ? replace : input
        destination.focus()
        expect(editor.state.selection.from).toBe(3)
        expect(editor.state.selection.to).toBe(8)
        if (owner === 'control') {
          fireEvent.mouseDown(control, { button: 0 })
        }
        editor.commands.setTextSelection({ from: 9, to: 12 })
        document.getSelection()?.setBaseAndExtent(text, 0, text, 1)
        document.dispatchEvent(new Event('selectionchange'))
        const mappings = vi.spyOn(editor.view, 'posAtDOM')
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Observe the pinned engine flush boundary without replacing it.
        const engine = editor.view as Editor['view'] & { domObserver: { forceFlush(): void } }
        const flushes = vi.spyOn(engine.domObserver, 'forceFlush')
        if (owner === 'return-before-release') {
          editor.view.focus()
        }
        fireEvent.mouseUp(document, { button: 0 })
        if (owner !== 'return-before-release') {
          expect(mappings).not.toHaveBeenCalled()
          expect(flushes).not.toHaveBeenCalled()
        }
        vi.runAllTimers()
        expect(editor.state.selection.from).toBe(9)
        expect(editor.state.selection.to).toBe(12)
        editor.view.focus()
        editor.commands.insertContent('new')
        vi.runAllTimers()
        expect(editor.view.dom.querySelector('p')?.textContent).toBe('lower canew')
      } finally {
        editor.destroy()
      }
    }
  )
}
