import { rememberSelection } from './editor-selection'
import { editorElement } from './editor-surface'
import type { RichMarkdownEditorScope } from './document-scope'

/**
 * Gives up focus, which is the only thing that closes the keyboard over a document.
 *
 * The caret is captured first because WebKit discards the DOM selection on blur, and the flag is
 * what tells the next command that the selection it cannot see is the saved one.
 */
export function dismissKeyboard(scope: RichMarkdownEditorScope) {
  rememberSelection(scope)
  scope.selectionDroppedOnBlur = true
  const active = scope.getDocument().activeElement
  if (active instanceof HTMLElement) {
    active.blur()
  }
  editorElement(scope).blur()
}
