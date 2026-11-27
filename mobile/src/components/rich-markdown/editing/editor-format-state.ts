import { editorElement } from './editor-surface'
import { post } from '../document/host-bridge'
import type { MobileRichMarkdownCommand } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorScope } from '../document/document-scope'

// [command, execCommand state, its markup, where the document's sheet draws that look without markup]
const INLINE_STATES: [MobileRichMarkdownCommand, string, string, string | null][] = [
  ['bold', 'bold', 'b, strong', 'h1, h2, h3, h4, h5, h6, th'],
  ['italic', 'italic', 'i, em', null],
  ['strike', 'strikeThrough', 's, del, strike', 'li[data-checked="true"]']
]

const BLOCK_SELECTORS: [MobileRichMarkdownCommand, string][] = [
  ['heading1', 'h1'],
  ['heading2', 'h2'],
  // Deeper levels read as the last step, so the next tap returns them to body text.
  ['heading3', 'h3, h4, h5, h6'],
  ['quote', 'blockquote'],
  ['codeBlock', 'pre'],
  ['link', 'a[href]']
]

function commandState(scope: RichMarkdownEditorScope, command: string): boolean {
  try {
    return scope.getDocument().queryCommandState(command)
  } catch {
    return false
  }
}

/** The styles under the caret, as the toolbar commands that apply them. */
function activeCommands(scope: RichMarkdownEditorScope): MobileRichMarkdownCommand[] {
  const editor = editorElement(scope)
  const node = scope.getSelection()?.anchorNode ?? null
  const anchor = node instanceof Element ? node : (node?.parentElement ?? null)
  if (!anchor || !editor.contains(anchor)) {
    return []
  }
  const within = (selector: string) => {
    const match = anchor.closest(selector)
    return match !== null && match !== editor && editor.contains(match)
  }
  const active: MobileRichMarkdownCommand[] = INLINE_STATES.filter(([, state, markup, styled]) =>
    styled !== null && within(styled) ? within(markup) : commandState(scope, state)
  ).map(([command]) => command)
  for (const [command, selector] of BLOCK_SELECTORS) {
    if (within(selector)) {
      active.push(command)
    }
  }
  if (within('code') && !within('pre')) {
    active.push('inlineCode')
  }
  const list = anchor.closest('ul, ol')
  if (list && editor.contains(list)) {
    active.push(
      list.tagName === 'OL'
        ? 'orderedList'
        : list.getAttribute('data-type') === 'taskList'
          ? 'taskList'
          : 'bulletList'
    )
  }
  return active
}

// Post focus and the caret's styles together, and only when they moved, so the host's row re-renders once per change.
export function reportFormatState(scope: RichMarkdownEditorScope) {
  if (scope.stopped) {
    return
  }
  const focused = scope.getDocument().activeElement === editorElement(scope)
  const active = focused ? activeCommands(scope) : []
  const key = `${focused}:${active.join(',')}`
  if (key === scope.lastFormatKey) {
    return
  }
  scope.lastFormatKey = key
  post(scope, { type: 'formatState', focused, active })
}

export function startFormatState(scope: RichMarkdownEditorScope) {
  const editor = editorElement(scope)
  const hostDocument = scope.getDocument()
  const report = () => reportFormatState(scope)
  editor.addEventListener('focus', report)
  editor.addEventListener('blur', report)
  hostDocument.addEventListener('selectionchange', report)
  scope.removeFormatState = () => {
    editor.removeEventListener('focus', report)
    editor.removeEventListener('blur', report)
    hostDocument.removeEventListener('selectionchange', report)
  }
}

export function stopFormatState(scope: RichMarkdownEditorScope) {
  scope.removeFormatState?.()
  scope.removeFormatState = null
}
