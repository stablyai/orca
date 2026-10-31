// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { CellSelection, tableEditingKey } from '@tiptap/pm/tables'
import type * as EditorInstance from '@/components/editor/useRichMarkdownEditorInstance'
import RichMarkdownEditor from '@/components/editor/RichMarkdownEditor'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installHappyDomSelectionNotificationTasks } from '@n1-dom-setup'
import { pastePrimarySelectionTextIntoTarget } from '@/lib/primary-selection-paste'
import { registerRetainedContracts as retainedWork } from './retained/adversarial'
import { registerRetainedContracts as retainedLifetime } from './retained/lifetime'

const protocol = process.env.PR35764_N1_PROTOCOL
const live = vi.hoisted((): { editor: Editor | null } => ({ editor: null }))
vi.mock('@/components/editor/useRichMarkdownEditorInstance', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorInstance>()
  return {
    useRichMarkdownEditorInstance: (
      ...args: Parameters<typeof actual.useRichMarkdownEditorInstance>
    ) => {
      const editor = actual.useRichMarkdownEditorInstance(...args)
      live.editor = editor
      return editor
    }
  }
})
const markdown = 'heading start\n\n---\n\n| A | B |\n| - | - |\n| C | D |\n\nlower caret'
const tools = () => globalThis.__PR35764_N1_TOOLS__
const mark = (name: string, editor?: Editor, detail = {}) => {
  tools().phase(name)
  tools().record(`fixture.${name}`, editor && !editor.isDestroyed ? editor.view : null, detail)
}
// SAFETY: private fields below match the exact pinned engine source; this packet never ships.
// Exact exposed private engine fields are source-contract inputs/observations, not replacement engine methods.
function engine(editor: Editor) {
  return editor.view as typeof editor.view & {
    input: {
      lastFocus: number
      lastTouch: number
      lastClick: { time: number }
      compositionPendingChanges: number
      mouseDown: { allowDefault: boolean; delayedSelectionSync: boolean; done(): void } | null
    }
    domObserver: {
      forceFlush(): void
      flush(): void
      flushSoon(): void
      setCurSelection(): void
      currentSelection: { anchorNode: Node | null; clear(): void }
      onSelectionChange(): void
    }
  }
}
function text(editor: Editor) {
  const value = editor.view.dom.querySelector(':scope > p:last-child')?.firstChild
  if (!value) {
    throw new Error('Actual production text not mounted')
  }
  return value
}
function nativeAt(editor: Editor, anchor: number, head: number) {
  const node = text(editor)
  document.getSelection()!.setBaseAndExtent(node, anchor, node, head)
}
function copy(editor: Editor) {
  const data = new DataTransfer()
  fireEvent(
    editor.view.dom,
    new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })
  )
  return data.getData('text/plain')
}
function settle(editor: Editor, phase = 'settlement') {
  mark(phase, editor)
  document.dispatchEvent(new Event('selectionchange'))
  vi.runAllTimers()
  mark(`${phase}.after`, editor)
}
function inputClock(editor: Editor) {
  // Declared source-contract timestamps: old click/touch; lastFocus is set ONLY by actual core focus.
  engine(editor).input.lastTouch = 0
  engine(editor).input.lastClick.time = 0
  mark('declared.oldClickTouch', editor, { lastTouch: 0, lastClickTime: 0 })
}
async function mount() {
  const view = render(
    <RichMarkdownEditor
      fileId="n1-contract"
      viewStateId="n1-view"
      content={markdown}
      filePath="/repo/n1.md"
      worktreeId="n1-workspace"
      scrollCacheKey="n1-contract"
      onContentChange={() => {}}
      onDirtyStateHint={() => {}}
      onSave={() => {}}
    />,
    { wrapper: TooltipProvider }
  )
  await waitFor(() => {
    if (!live.editor) {
      throw new Error('Editor not created')
    }
    expect(live.editor.isInitialized).toBe(true)
    expect(live.editor.view.dom.isConnected).toBe(true)
    expect(view.container.contains(live.editor.view.dom)).toBe(true)
  })
  const editor = live.editor!
  tools().observeEditor(editor)
  // Await the actual production autofocus/focus-correction callback, before switching clocks or declaring S/H.
  // This observation is a fixture lifecycle barrier only; no diagnostic data enters the probe's branches.
  await waitFor(() => {
    const viewId = tools().id(editor.view)
    expect(
      tools()
        .rows()
        .some(
          (row) => row.event === 'engine.core.focusTimerComplete' && row.snapshot?.view === viewId
        )
    ).toBe(true)
  })
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  const outside = document.createElement('input')
  outside.setAttribute('aria-label', 'foreign owner')
  document.body.append(outside)
  return { editor, view, outside }
}
function accepted(editor: Editor, kind: 'Cell' | 'Node' | 'Text') {
  editor.view.focus()
  const positions: number[] = []
  let atom: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      positions.push(pos)
    }
    if (node.type.name === 'horizontalRule') {
      atom = pos
    }
  })
  if (kind === 'Cell') {
    if (positions.length !== 4) {
      throw new Error('Expected actual 2x2 production table')
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(
        new CellSelection(
          editor.state.doc.resolve(positions[0]),
          editor.state.doc.resolve(positions[3])
        )
      )
    )
  } else if (kind === 'Node') {
    if (atom === null) {
      throw new Error('Expected production horizontalRule atom')
    }
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, atom)))
  } else {
    const node = text(editor)
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          editor.state.doc,
          editor.view.posAtDOM(node, 11),
          editor.view.posAtDOM(node, 6)
        )
      )
    )
  }
  settle(editor, 'accepted.setup')
  expect(engine(editor).input.mouseDown).toBeNull()
  expect(tableEditingKey.getState(editor.state)).toBeNull()
  mark('declared.acceptedS', editor, { kind, syntheticModelSetup: true })
  return editor.state.selection
}
function incoming(editor: Editor, outside: HTMLInputElement) {
  outside.focus()
  inputClock(editor)
  mark('incoming.actualDomFocus.before', editor)
  editor.view.dom.focus()
  mark('incoming.actualDomFocus.after', editor)
  expect(engine(editor).input.lastFocus).toBe(Date.now())
  const start = editor.view.dom.querySelector('p')?.firstChild
  if (!start) {
    throw new Error('Expected document start text')
  }
  mark('declared.syntheticH', editor, {
    node: tools().id(start),
    offset: 0,
    nativeReproduction: false
  })
  document.getSelection()!.setBaseAndExtent(start, 0, start, 0)
}

if (protocol !== 'main') {
  // Registration-only relocation: all original bodies/assertions and own fixture hooks are unchanged.
  describe('retained exact current work/native/engine settlement contracts', retainedWork)
  describe('retained exact lifetime/reconfigure/remount contracts', retainedLifetime)
}

describe('R3 bounded semantic acceptance controls (synthetic source inputs)', () => {
  let dispose: (() => void) | null = null
  beforeEach(() => {
    dispose = installHappyDomSelectionNotificationTasks(document)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          setMarkdownEditorFocused: vi.fn(),
          onRichMarkdownContextCommand: () => () => {}
        }
      }
    })
  })
  afterEach(() => {
    try {
      cleanup()
    } finally {
      dispose?.()
      dispose = null
      vi.useRealTimers()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      document.body.replaceChildren()
      live.editor = null
    }
  })

  it.each([
    { kind: 'Cell', entry: 'notification' },
    { kind: 'Cell', entry: 'copy' },
    { kind: 'Cell', entry: 'key' },
    { kind: 'Node', entry: 'notification' },
    { kind: 'Text', entry: 'notification' },
    { kind: 'Cell', entry: 'pending-flush' }
  ] as const)(
    'I accepted $kind through $entry preserves target then actual consumer',
    async ({ kind, entry }) => {
      const { editor, outside } = await mount()
      const S = accepted(editor, kind)
      const expectedCopy = copy(editor)
      if (kind !== 'Node') {
        expect(expectedCopy).not.toBe('')
      }
      const publications = vi.fn()
      editor.on('selectionUpdate', publications)
      incoming(editor, outside)
      if (entry === 'pending-flush') {
        engine(editor).domObserver.flushSoon()
      }
      mark(`measured.${entry}`, editor, { entry, kind })
      if (entry === 'notification') {
        vi.advanceTimersByTime(0)
      } else if (entry === 'copy') {
        copy(editor)
      } else {
        fireEvent.keyDown(editor.view.dom, { key: 'Control', keyCode: 17 })
      }
      mark('measured.immediate', editor, { entry, kind })
      expect.soft(editor.state.selection.eq(S)).toBe(true)
      expect.soft(publications).not.toHaveBeenCalled()
      const copied = copy(editor)
      mark('measured.copy', editor, { copied, expectedCopy })
      expect.soft(copied).toBe(expectedCopy)
      settle(editor)
      expect.soft(editor.state.selection.eq(S)).toBe(true)
      expect.soft(publications).not.toHaveBeenCalled()
      editor.off('selectionUpdate', publications)
      const heading = editor.view.dom.querySelector('p')?.textContent
      act(() => {
        editor.commands.insertContent('xy')
      })
      mark('consumer.insertContent', editor, {
        headingBefore: heading,
        headingAfter: editor.view.dom.querySelector('p')?.textContent
      })
      expect.soft(editor.view.dom.querySelector('p')?.textContent).toBe('heading start')
      expect(editor.getText()).toContain('xy')
    }
  )

  it.each(['Cell', 'Node'] as const)(
    'untouched $kind with actual contained blur/cache clear follows callback and focus writer',
    async (kind) => {
      const { editor } = await mount()
      const S = accepted(editor, kind)
      const contained = editor.view.dom.querySelector('p')
      if (!contained) {
        throw new Error('Expected existing contained DOM target')
      }
      mark('declared.containedBlur', editor, {
        unchangedPresentation: true,
        syntheticRelatedTarget: true,
        nativeReachabilityUnproved: true
      })
      // Invoke actual core blur path with an editor-contained relatedTarget; no cache sentinel setter.
      fireEvent.blur(editor.view.dom, { relatedTarget: contained })
      expect(engine(editor).domObserver.currentSelection.anchorNode).toBeNull()
      fireEvent.focus(editor.view.dom)
      inputClock(editor)
      mark('measured.structuredCacheMismatch', editor)
      if (protocol === 'current') {
        // Deliberately unsafe stage control prescribed by R3; this is not a fourth repair protocol.
        mark('unsafe.addedFlushWithoutVeto', editor)
        engine(editor).domObserver.flush()
        mark('unsafe.after', editor)
      } else {
        fireEvent.keyDown(editor.view.dom, { key: 'Control', keyCode: 17 })
        mark('probeVeto.return', editor)
      }
      document.dispatchEvent(new Event('selectionchange'))
      vi.runAllTimers()
      mark('structured.callbackAndFocusTimer.settled', editor)
      expect.soft(editor.state.selection.eq(S)).toBe(true)
    }
  )

  it.each([
    'equal-text-cache-different',
    'active-table-equivalent',
    'changed-held-cached',
    'changed-uncached-reverse'
  ] as const)('actual read effects versus skip: %s', async (input) => {
    const { editor } = await mount()
    const S = accepted(editor, input === 'active-table-equivalent' ? 'Cell' : 'Text')
    // Source-contract timestamp disables reset for this distinct equivalence experiment.
    engine(editor).input.lastFocus = 0
    mark('declared.equivalenceInput', editor, { input, lastFocus: 0 })
    if (input === 'active-table-equivalent') {
      if (!(S instanceof CellSelection)) {
        throw new Error('Expected actual CellSelection')
      }
      const cell = S.$anchorCell.pos
      editor.view.dispatch(editor.state.tr.setMeta(tableEditingKey, cell))
      const cells = editor.view.dom.querySelectorAll('th p, td p')
      const first = cells[0]?.firstChild
      const last = cells.item(cells.length - 1)?.firstChild
      if (!first || !last) {
        throw new Error('Expected actual table content endpoints')
      }
      mark('declared.activeTableNativeR', editor, { syntheticNativeInput: true })
      document.getSelection()!.setBaseAndExtent(first, 0, last, 1)
      engine(editor).domObserver.currentSelection.clear()
    } else if (input === 'equal-text-cache-different') {
      engine(editor).domObserver.currentSelection.clear()
    } else {
      const node = text(editor)
      if (input === 'changed-held-cached') {
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
          pos: editor.state.selection.head,
          inside: -1
        })
        fireEvent.mouseDown(node.parentElement ?? editor.view.dom, {
          button: 0,
          buttons: 1,
          shiftKey: true
        })
        expect(engine(editor).input.mouseDown?.allowDefault).toBe(true)
      }
      nativeAt(editor, 9, 3)
      if (input === 'changed-held-cached') {
        document.dispatchEvent(new Event('selectionchange'))
      }
    }
    // Nonzero pending composition is a declared source counter, not a fabricated live composition session.
    engine(editor).input.compositionPendingChanges = 41
    mark('measured.equivalentOrSkipped', editor, { pendingCompositionInput: 41 })
    fireEvent.keyDown(editor.view.dom, { key: 'Control', keyCode: 17 })
    mark('measured.after', editor)
    if (input.startsWith('changed')) {
      const node = text(editor)
      expect.soft(editor.state.selection.anchor).toBe(editor.view.posAtDOM(node, 9))
      expect.soft(editor.state.selection.head).toBe(editor.view.posAtDOM(node, 3))
    } else {
      expect.soft(editor.state.selection.eq(S)).toBe(true)
    }
    fireEvent.mouseUp(document, { button: 0 })
    settle(editor)
  })

  it.each(['I2-synthetic', 'genuine-outgoing'] as const)(
    '%s without a global focus gate',
    async (input) => {
      const { editor, outside } = await mount()
      const S = accepted(editor, 'Text')
      if (input === 'I2-synthetic') {
        incoming(editor, outside)
      } else {
        engine(editor).input.lastFocus = 0
        nativeAt(editor, 9, 3)
      }
      mark('measured.outgoingFocus', editor, {
        input,
        sourceOnlySyntheticH: input === 'I2-synthetic'
      })
      outside.focus()
      expect(editor.view.hasFocus()).toBe(false)
      mark('measured.afterUnfocusedBlur', editor)
      settle(editor)
      if (input === 'I2-synthetic') {
        expect.soft(editor.state.selection.eq(S)).toBe(true)
      } else {
        const node = text(editor)
        expect.soft(editor.state.selection.anchor).toBe(editor.view.posAtDOM(node, 9))
        expect.soft(editor.state.selection.head).toBe(editor.view.posAtDOM(node, 3))
      }
      expect(document.activeElement).toBe(outside)
    }
  )

  it.each([
    'mousedown-start',
    'keyboard-start',
    'focus-start',
    'point-paste',
    'replacement'
  ] as const)('intentional current action remains authoritative: %s', async (action) => {
    const { editor, view, outside } = await mount()
    accepted(editor, 'Text')
    outside.focus()
    inputClock(editor)
    editor.view.dom.focus()
    if (action === 'mousedown-start') {
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: -1 })
      fireEvent.mouseDown(editor.view.dom.querySelector('p')!, { button: 0, buttons: 1 })
      const first = editor.view.dom.querySelector('p')!.firstChild!
      document.getSelection()!.setBaseAndExtent(first, 0, first, 0)
      fireEvent.mouseUp(document, { button: 0 })
    } else if (action === 'keyboard-start') {
      mark('measured.actualStartKey', editor, { oldClickTouch: true, recentActualFocus: true })
      const allowedDefault = fireEvent.keyDown(editor.view.dom, {
        key: 'Home',
        code: 'Home',
        keyCode: 36,
        ctrlKey: true
      })
      mark('intentional.startKey.actualHandlerResult', editor, {
        allowedDefault,
        browserNativeDefaultUnimplemented: true
      })
      // No emulated default gesture or seeded range: an unhandled native key remains an explicit proof gap.
    } else if (action === 'focus-start') {
      editor.commands.focus('start', { scrollIntoView: false })
    } else if (action === 'point-paste') {
      const node = editor.view.dom.querySelector('p')!.firstChild!
      const prior = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => ({ offsetNode: node, offset: 0 })
      })
      try {
        await pastePrimarySelectionTextIntoTarget(editor.view.dom, 'P', { clientX: 0, clientY: 0 })
      } finally {
        if (prior) {
          Object.defineProperty(document, 'caretPositionFromPoint', prior)
        } else {
          Reflect.deleteProperty(document, 'caretPositionFromPoint')
        }
      }
    } else {
      view.rerender(
        <TooltipProvider>
          <RichMarkdownEditor
            fileId="n1-contract"
            viewStateId="n1-view"
            content="replacement"
            filePath="/repo/n1.md"
            worktreeId="n1-workspace"
            scrollCacheKey="n1-contract"
            onContentChange={() => {}}
            onDirtyStateHint={() => {}}
            onSave={() => {}}
          />
        </TooltipProvider>
      )
    }
    settle(editor, 'intentional.actionSettlement')
    if (action === 'replacement') {
      expect(editor.getMarkdown()).toBe('replacement')
    } else if (action === 'point-paste') {
      expect(editor.getText()).toContain('Pheading start')
    } else {
      expect.soft(editor.state.selection.head).toBe(1)
    }
    mark('intentional.final', editor, { action })
  })

  it.each(['replace-document', 'destroy', 'reconfigure', 'foreign-owner'] as const)(
    'pending real engine dispatch loses old capture authority: %s',
    async (action) => {
      const { editor, outside } = await mount()
      accepted(editor, 'Text')
      engine(editor).input.lastFocus = 0
      nativeAt(editor, 9, 3)
      // An actual characterData mutation causes pending flush to dispatch; continuation is real onTransaction.
      let fired = false
      const continuation = ({ transaction }: { transaction: { docChanged: boolean } }) => {
        if (fired || !transaction.docChanged) {
          return
        }
        fired = true
        mark('continuation.actualAppliedDocumentChange', editor, { action })
        if (action === 'destroy') {
          editor.destroy()
        } else if (action === 'reconfigure') {
          editor.unregisterPlugin('dragSelectionGuard')
        } else if (action === 'foreign-owner') {
          outside.focus()
        } else {
          editor.commands.setContent('replacement', { contentType: 'markdown' })
        }
      }
      editor.on('transaction', continuation)
      text(editor).textContent = 'mutated caret'
      engine(editor).domObserver.flushSoon()
      mark('measured.pendingDispatch', editor, { action })
      try {
        fireEvent.keyDown(editor.view.dom, { key: 'Control', keyCode: 17 })
      } finally {
        editor.off('transaction', continuation)
      }
      vi.runAllTimers()
      mark('continuation.fullSettlement', editor, { action, fired })
      expect(fired).toBe(true)
      if (action === 'replace-document') {
        expect(editor.getMarkdown()).toBe('replacement')
      }
      if (action === 'destroy') {
        expect(editor.isDestroyed).toBe(true)
      }
      if (action === 'foreign-owner') {
        expect(document.activeElement).toBe(outside)
      }
      // This case observes boundary exits, not completeness of a repair for the changed document/owner.
    }
  )
})
