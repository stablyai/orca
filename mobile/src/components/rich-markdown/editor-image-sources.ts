import { editorElement } from './editor-surface'
import type { RichMarkdownEditorScope } from './document-scope'

// Display URLs leave the authored Markdown source intact.
export function setImageSources(scope: RichMarkdownEditorScope, sources: Record<string, string>) {
  scope.imageSources = sources
  applyImageSources(scope)
}

/** Applies the stored display URLs to whatever images the surface holds right now. */
export function applyImageSources(scope: RichMarkdownEditorScope) {
  const sources = scope.imageSources
  if (!sources) {
    return
  }
  editorElement(scope)
    .querySelectorAll('img[data-orca-src]')
    .forEach((image) => {
      const authored = image.getAttribute('data-orca-src') ?? ''
      const display = sources[authored]
      const next = typeof display === 'string' && display.length > 0 ? display : authored
      if (image.getAttribute('src') !== next) {
        image.setAttribute('src', next)
      }
    })
}
