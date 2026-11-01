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

const BLOCK_CONTENT = 'p,div,h1,h2,h3,h4,h5,h6,blockquote,pre,ul,ol,li,table,thead,tbody,tr,th,td'
const INLINE_BOUNDARY = `${BLOCK_CONTENT},br,img,input,hr,[contenteditable="false"]`

function selectedInlineRuns(parent: ParentNode, selected: Range): Range[] {
  const ranges: Range[] = []
  const hasBlocks = Array.from(parent.children).some((child) => child.matches(BLOCK_CONTENT))
  let run: Node[] = []
  const flush = () => {
    const first = run[0]
    const last = run.at(-1)
    if (first && last) {
      const range = selected.cloneRange()
      range.setStartBefore(first)
      range.setEndAfter(last)
      if (selected.comparePoint(range.startContainer, range.startOffset) < 0) {
        range.setStart(selected.startContainer, selected.startOffset)
      }
      if (selected.comparePoint(range.endContainer, range.endOffset) > 0) {
        range.setEnd(selected.endContainer, selected.endOffset)
      }
      const text = range.toString()
      if (!range.collapsed && text && (!hasBlocks || text.trim())) {
        ranges.push(range)
      }
    }
    run = []
  }
  for (const child of Array.from(parent.childNodes)) {
    if (!selected.intersectsNode(child)) {
      flush()
      continue
    }
    if (
      child instanceof Element &&
      (child.matches(INLINE_BOUNDARY) || child.querySelector(INLINE_BOUNDARY))
    ) {
      flush()
      if (!child.matches('br,img,input,hr,[contenteditable="false"],pre')) {
        ranges.push(...selectedInlineRuns(child, selected))
      }
    } else {
      run.push(child)
    }
  }
  flush()
  return ranges
}

// Keep inline code inside each selected block and outside embedded controls.
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
  const ranges = selectedInlineRuns(editorElement(scope), range)
  const wrappers: HTMLElement[] = []
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const selected = ranges[index]
    const wrapper = scope.getDocument().createElement(tagName)
    try {
      selected.surroundContents(wrapper)
    } catch {
      wrapper.appendChild(selected.extractContents())
      selected.insertNode(wrapper)
    }
    wrappers.unshift(wrapper)
  }
  const first = wrappers[0]
  const last = wrappers.at(-1)
  if (first && last) {
    const formatted = scope.getDocument().createRange()
    formatted.setStart(first, 0)
    formatted.setEnd(last, last.childNodes.length)
    applySelectionRange(scope, formatted)
  }
}
