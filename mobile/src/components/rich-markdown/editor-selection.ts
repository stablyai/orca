import { editorElement } from './editor-surface'
import type { RichMarkdownEditorScope } from './document-scope'

export function focusEditor(scope: RichMarkdownEditorScope) {
  editorElement(scope).focus()
}

/** Keeps a copy of the caret while it is still live, for a blur that is about to drop it. */
export function rememberSelection(scope: RichMarkdownEditorScope) {
  const selection = scope.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return
  }
  const range = selection.getRangeAt(0)
  if (editorElement(scope).contains(range.commonAncestorContainer)) {
    scope.savedSelectionRange = range.cloneRange()
  }
}

export function applySelectionRange(scope: RichMarkdownEditorScope, range: Range) {
  const selection = scope.getSelection()
  if (!selection) {
    return
  }
  selection.removeAllRanges()
  selection.addRange(range)
  scope.savedSelectionRange = range.cloneRange()
}

/** Where a tap landed, through whichever of the two APIs this engine carries. */
export function caretRangeAtPoint(
  scope: RichMarkdownEditorScope,
  x: number,
  y: number
): Range | null {
  const hostDocument = scope.getDocument()
  if (hostDocument.caretRangeFromPoint) {
    return hostDocument.caretRangeFromPoint(x, y)
  }
  if (!hostDocument.caretPositionFromPoint) {
    return null
  }
  const position = hostDocument.caretPositionFromPoint(x, y)
  if (!position) {
    return null
  }
  const range = hostDocument.createRange()
  range.setStart(position.offsetNode, position.offset)
  range.collapse(true)
  return range
}

// Prefer the live caret, then WebKit’s saved blur range, then the end; otherwise every post-dismissal command inserts at document end.
export function restoreSelectionOrEnd(scope: RichMarkdownEditorScope) {
  focusEditor(scope)
  const selection = scope.getSelection()
  if (!selection) {
    return
  }
  const saved = scope.savedSelectionRange
  if (
    scope.selectionDroppedOnBlur &&
    saved &&
    editorElement(scope).contains(saved.commonAncestorContainer)
  ) {
    scope.selectionDroppedOnBlur = false
    applySelectionRange(scope, saved)
    return
  }
  if (selection.rangeCount > 0) {
    return
  }
  collapseToEnd(scope)
}

/** The caret at the end of the document, which is where a command with nothing to act on goes. */
function collapseToEnd(scope: RichMarkdownEditorScope) {
  const range = scope.getDocument().createRange()
  range.selectNodeContents(editorElement(scope))
  range.collapse(false)
  applySelectionRange(scope, range)
}

// Unconditionally restore URL command’s saved caret after modal takes focus; execCommand otherwise inserts nothing on both engines. Wait itself proves blur without flag.
export function restoreRememberedSelection(scope: RichMarkdownEditorScope) {
  focusEditor(scope)
  const saved = scope.savedSelectionRange
  if (saved && editorElement(scope).contains(saved.commonAncestorContainer)) {
    applySelectionRange(scope, saved)
    return
  }
  collapseToEnd(scope)
}

// Wrap selected format lacking execCommand verb; extract/reinsert if surroundContents crosses element boundary. Emit nothing because runCommand alone reports change.
export function wrapSelection(scope: RichMarkdownEditorScope, tagName: string) {
  restoreSelectionOrEnd(scope)
  const selection = scope.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return
  }
  const range = selection.getRangeAt(0)
  if (range.collapsed) {
    return
  }
  const wrapper = scope.getDocument().createElement(tagName)
  try {
    range.surroundContents(wrapper)
  } catch {
    wrapper.appendChild(range.extractContents())
    range.insertNode(wrapper)
  }
  selection.removeAllRanges()
  selection.selectAllChildren(wrapper)
}
