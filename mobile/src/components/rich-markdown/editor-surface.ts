import { RICH_MARKDOWN_EDITOR_ELEMENT_ID } from './document-markup'
import type { RichMarkdownEditorScope } from './document-scope'

/**
 * The editable surface.
 *
 * Null only before the start sequence has read it, which nothing exported from these modules is
 * reachable from: the factory starts the document before it hands a host anything to call. A host
 * whose markup carries no surface therefore fails on the first property read, exactly as the
 * script's own unguarded `editor` did.
 */
export function editorElement(scope: RichMarkdownEditorScope): HTMLElement {
  return scope.editor!
}

/**
 * Reads the surface out of the host's page, once per document.
 *
 * At start rather than where the modules are parsed (ruling 20): an ES module body runs once per
 * page, so a read there would hand every later mount the first one's element.
 */
export function startEditorSurface(scope: RichMarkdownEditorScope) {
  scope.editor = scope.getDocument().getElementById(RICH_MARKDOWN_EDITOR_ELEMENT_ID)
}
