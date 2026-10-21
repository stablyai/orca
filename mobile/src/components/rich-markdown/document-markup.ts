/**
 * The one element the document's modules reach for: the editable surface.
 *
 * The page mount plants it in its host element, and the editor tests plant the same markup.
 */
export const RICH_MARKDOWN_EDITOR_MARKUP =
  '<main id="editor" contenteditable="true" data-placeholder="Start writing..."></main>'

/** The id the markup gives the editable surface, read once when the document starts. */
export const RICH_MARKDOWN_EDITOR_ELEMENT_ID = 'editor'
