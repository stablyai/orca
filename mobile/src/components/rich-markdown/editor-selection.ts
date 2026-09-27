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

/**
 * The caret a command should act on: the live one, the one the dismissal saved, or the end.
 *
 * WebKit drops the DOM selection on blur, so without the saved range every command after a
 * keyboard dismissal would insert at the end of the document rather than where the user left off.
 */
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

/**
 * Puts the caret back where the host's dialog found it.
 *
 * A command that has to ask for a URL gives the caret up while it waits: the page's modal takes
 * focus into its own field, and `execCommand` on a document that does not hold the selection
 * inserts nothing at all — measured in both engines, with Link and Image doing nothing on a page
 * whose modal had just answered. Unconditional, unlike `restoreSelectionOrEnd`, because the wait
 * itself is the blur and there is nothing for a flag to tell it.
 */
export function restoreRememberedSelection(scope: RichMarkdownEditorScope) {
  focusEditor(scope)
  const saved = scope.savedSelectionRange
  if (saved && editorElement(scope).contains(saved.commonAncestorContainer)) {
    applySelectionRange(scope, saved)
    return
  }
  collapseToEnd(scope)
}

/**
 * Wraps the selection in one element, for the formats `execCommand` has no verb for.
 *
 * `surroundContents` refuses a range that crosses an element boundary, and the fallback extracts
 * and reinserts instead, which is the same result for every selection the toolbar can produce.
 *
 * Emits nothing: `runCommand` is the only caller's caller and reports the change itself.
 */
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
