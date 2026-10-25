import { RICH_MARKDOWN_EDITOR_ELEMENT_ID } from './document-markup'
import type { RichMarkdownEditorScope } from './document-scope'

// Factory starts before exposing API, so surface is non-null when reachable; missing markup fails first property read like native unguarded script.
export function editorElement(scope: RichMarkdownEditorScope): HTMLElement {
  return scope.editor!
}

// Read surface per start, not module parse: ES modules execute once and would give later mounts first element. Use root.querySelector for host-scoped lookup (ruling 20).
export function startEditorSurface(scope: RichMarkdownEditorScope) {
  const root = scope.root ?? scope.getDocument()
  scope.editor = root.querySelector<HTMLElement>(`#${RICH_MARKDOWN_EDITOR_ELEMENT_ID}`)
}
