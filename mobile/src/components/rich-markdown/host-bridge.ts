import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorScope } from './document-scope'

/** Every message the document sends its host goes through here, and through the seam below it. */
export function post(scope: RichMarkdownEditorScope, message: MobileRichMarkdownEditorMessage) {
  scope.postToHost(message)
}

// Send ready last, after listeners and keyboard measurement: host may synchronously set content/adjust bar in response.
export function startHostBridge(scope: RichMarkdownEditorScope) {
  post(scope, { type: 'ready' })
}
