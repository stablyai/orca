import { editorElement } from './editor-surface'
import type { RichMarkdownEditorScope } from './document-scope'

/**
 * Display URLs for the markdown's relative image srcs, applied to the surface without touching
 * what the document serializes.
 *
 * The editor document's origin is a placeholder host, so a repository-relative `![alt](dir/a.png)`
 * can only ever render broken. The host reads those files itself and hands their data URLs back,
 * keyed by the authored src. `data-orca-src` carries that key on the element — `src` is the
 * display slot the host owns, and `inlineMarkdown` reads the key, so a displayed image never
 * round-trips its data URL into the saved file.
 */
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
      const display = sources[image.getAttribute('data-orca-src') ?? '']
      if (typeof display === 'string' && display.length > 0) {
        image.setAttribute('src', display)
      }
    })
}
