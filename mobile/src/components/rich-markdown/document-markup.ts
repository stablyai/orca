/**
 * The one element the document's modules reach for: the editable surface.
 *
 * It is here rather than in the HTML builder because both hosts plant it — the native document
 * carries it in its `<body>`, and a page mounting these modules puts the same markup in its host
 * element — and a document whose markup differed between the two would be two documents.
 */
export const RICH_MARKDOWN_EDITOR_MARKUP =
  '<main id="editor" contenteditable="true" data-placeholder="Start writing..."></main>'

/** The id the markup gives the editable surface, read once when the document starts. */
export const RICH_MARKDOWN_EDITOR_ELEMENT_ID = 'editor'
