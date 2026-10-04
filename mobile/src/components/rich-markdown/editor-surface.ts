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
 * Reads the surface out of the host's own root, once per document.
 *
 * At start rather than where the modules are parsed (ruling 20): an ES module body runs once per
 * page, so a read there would hand every later mount the first one's element.
 *
 * `querySelector` under the root rather than `getElementById`, because a root may be an element:
 * the page's host carries the markup, and only the WebView's document is a whole document.
 */
export function startEditorSurface(scope: RichMarkdownEditorScope) {
  const root = scope.root ?? scope.getDocument()
  scope.editor = root.querySelector<HTMLElement>(`#${RICH_MARKDOWN_EDITOR_ELEMENT_ID}`)
}
