import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import type { EditorView } from '@tiptap/pm/view'

type NativeRange = {
  anchorNode: Node | null
  anchorOffset: number
  focusNode: Node | null
  focusOffset: number
}

type SelectionView = EditorView & {
  input: { mouseDown: { allowDefault: boolean } | null }
  domSelectionRange(): NativeRange
  domObserver: {
    onSelectionChange(): void
    setCurSelection(): void
    forceFlush(): void
    flush(): void
    stop(): void
    start(): void
    ignoreSelectionChange(selection: NativeRange): boolean
    handleDOMChange(from: number, to: number, typeOver: boolean, added: Node[]): void
  }
}

function selectionView(view: EditorView): SelectionView {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The pinned engine's existing observer bridge owns these internal input/selection hooks.
  return view as SelectionView
}

/** Publish native input before an editor action consumes it or outgoing focus discards its endpoints. */
export function completeRichMarkdownSelection(editorView: EditorView): false {
  if (editorView.isDestroyed || !editorView.dom.isConnected || editorView.composing) {
    return false
  }
  const view = selectionView(editorView)
  const observer = view.domObserver
  const D0 = view.state.doc,
    S0 = view.state.selection,
    plugins0 = view.state.plugins
  const document0 = view.dom.ownerDocument,
    owner0 = document0.activeElement
  const stage = (name: string): void => {
    globalThis.__PR35764_N1__?.(`routed.${name}`, view)
  }
  const valid = (): boolean =>
    !view.isDestroyed &&
    view.dom.isConnected &&
    !view.composing &&
    view.domObserver === observer &&
    view.state.doc === D0 &&
    view.state.plugins === plugins0 &&
    view.dom.ownerDocument === document0 &&
    document0.activeElement === owner0
  const snapshot = (): NativeRange => {
    const live = view.domSelectionRange()
    return {
      anchorNode: live.anchorNode,
      anchorOffset: live.anchorOffset,
      focusNode: live.focusNode,
      focusOffset: live.focusOffset
    }
  }
  stage('beforeForceFlush')
  observer.forceFlush()
  stage('afterForceFlush')
  if (!valid()) {
    stage('invalidated.forceFlush')
    return false
  }
  const range = snapshot()
  const { anchorNode, anchorOffset, focusNode, focusOffset } = range
  if (
    !anchorNode ||
    !focusNode ||
    !anchorNode.isConnected ||
    !focusNode.isConnected ||
    !view.dom.contains(anchorNode) ||
    !view.dom.contains(focusNode)
  ) {
    return false
  }
  const ignored = observer.ignoreSelectionChange(range)
  if (!valid()) {
    stage('invalidated.ignore')
    return false
  }
  if (ignored) {
    return false
  }
  const selection = view.state.selection
  if (!(selection instanceof TextSelection)) {
    const anchor = view.posAtDOM(anchorNode, anchorOffset)
    const head = view.posAtDOM(focusNode, focusOffset)
    const presentation = TextSelection.between(selection.$anchor, selection.$head)
    if (!valid()) {
      stage('invalidated.structured')
      return false
    }
    if (
      (anchor === selection.anchor && head === selection.head) ||
      (anchor === presentation.anchor && head === presentation.head)
    ) {
      stage('structuredVeto')
      return false
    }
  }
  if (view.hasFocus() && !view.input.mouseDown?.allowDefault) {
    stage('focused.beforeFlush')
    observer.flush()
    stage('focused.afterFlush')
    if (!valid()) {
      stage('invalidated.focusedFlush')
    }
    return false
  }
  stage('direct.beforeRead')
  const anchor = view.posAtDOM(anchorNode, anchorOffset)
  const head = view.posAtDOM(focusNode, focusOffset)
  if (!valid()) {
    stage('invalidated.mapping')
    return false
  }
  observer.stop()
  try {
    if (!valid()) {
      stage('invalidated.stop')
      return false
    }
    observer.handleDOMChange(-1, -1, false, [])
    stage('direct.afterRead')
    if (!valid()) {
      stage('invalidated.directRead')
      return false
    }
    if (
      !view.state.selection.eq(S0) &&
      view.state.selection instanceof TextSelection &&
      view.state.selection.anchor === anchor &&
      view.state.selection.head === head &&
      anchorNode.isConnected &&
      focusNode.isConnected
    ) {
      document0.getSelection()?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
    }
    if (valid()) {
      observer.setCurSelection()
    } else {
      stage('invalidated.restoration')
    }
  } finally {
    if (!view.isDestroyed && view.domObserver === observer) {
      observer.start()
    }
  }
  return false
}

// These editor handlers run through the engine's NodeView stopEvent gating, before model-consuming handlers.
export const richMarkdownSelectionCompletionEvents = {
  mousedown: completeRichMarkdownSelection,
  keydown: completeRichMarkdownSelection,
  beforeinput: completeRichMarkdownSelection,
  copy: completeRichMarkdownSelection,
  cut: completeRichMarkdownSelection,
  paste: completeRichMarkdownSelection,
  compositionstart: completeRichMarkdownSelection,
  dragstart: completeRichMarkdownSelection,
  blur: completeRichMarkdownSelection
}

/** Protect native drags while the editor remains the sole owner of the remembered selection. */
export const DragSelectionGuard = Extension.create({
  name: 'dragSelectionGuard',

  addProseMirrorPlugins() {
    let viewRef: SelectionView | null = null
    return [
      new Plugin({
        key: new PluginKey('dragSelectionGuard'),
        filterTransaction(tr) {
          const mouseDown = viewRef?.input.mouseDown
          // Cell decorations force native selection rewrites during text drags (including Shift extension).
          return !(mouseDown?.allowDefault && tr.selection instanceof CellSelection)
        },
        view(editorView) {
          viewRef = selectionView(editorView)
          const observer = viewRef.domObserver
          const doc = editorView.dom.ownerDocument
          const completeNativeGesture = (event: MouseEvent): void => {
            if (
              (event.type === 'mouseup' ? event.button === 0 : event.buttons === 0) &&
              viewRef?.input.mouseDown?.allowDefault &&
              editorView.hasFocus()
            ) {
              completeRichMarkdownSelection(editorView)
            }
          }
          doc.addEventListener('mouseup', completeNativeGesture, true)
          doc.addEventListener('mousemove', completeNativeGesture, true)
          const originalOnSelectionChange = observer.onSelectionChange
          doc.removeEventListener('selectionchange', originalOnSelectionChange)
          const patchedOnSelectionChange = (): void => {
            if (viewRef?.input.mouseDown?.allowDefault) {
              observer.setCurSelection()
              return
            }
            originalOnSelectionChange()
          }
          observer.onSelectionChange = patchedOnSelectionChange
          doc.addEventListener('selectionchange', patchedOnSelectionChange)
          return {
            destroy() {
              doc.removeEventListener('mouseup', completeNativeGesture, true)
              doc.removeEventListener('mousemove', completeNativeGesture, true)
              doc.removeEventListener('selectionchange', patchedOnSelectionChange)
              observer.onSelectionChange = originalOnSelectionChange
              doc.addEventListener('selectionchange', originalOnSelectionChange)
              // Plugin views die after observer disconnect; retain live reconfiguration without leaking on destruction.
              queueMicrotask(() => {
                if (editorView.isDestroyed) {
                  doc.removeEventListener('selectionchange', originalOnSelectionChange)
                }
              })
              viewRef = null
            }
          }
        }
      })
    ]
  }
})
