import { rememberSelection } from './editor-selection'
import { editorElement } from './editor-surface'
import type { RichMarkdownEditorScope } from './document-scope'

// Save caret before blur closes keyboard because WebKit drops DOM selection; flag tells next command to restore saved range.
export function dismissKeyboard(scope: RichMarkdownEditorScope) {
  rememberSelection(scope)
  scope.selectionDroppedOnBlur = true
  const active = scope.getDocument().activeElement
  if (active instanceof HTMLElement) {
    active.blur()
  }
  editorElement(scope).blur()
}
