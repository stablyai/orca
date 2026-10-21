import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorScope } from './document-scope'

/** Every message the document sends its host goes through here, and through the seam below it. */
export function post(scope: RichMarkdownEditorScope, message: MobileRichMarkdownEditorMessage) {
  scope.postToHost(message)
}

/**
 * The document's last act at start: it is built and listening, so the host may send content.
 *
 * Last of the sequence rather than first, because a host that answers `ready` by setting markdown
 * would otherwise reach a surface whose listeners are not installed yet — and because the inset
 * the host lifts its bar by is measured before the host is told there is anything to lift for.
 */
export function startHostBridge(scope: RichMarkdownEditorScope) {
  post(scope, { type: 'ready' })
}
