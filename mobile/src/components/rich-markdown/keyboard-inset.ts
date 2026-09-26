import { post } from './host-bridge'
import type { RichMarkdownKeyboardInsetReader } from './document-host-seams'
import type { RichMarkdownEditorScope } from './document-scope'

/** Posts the covered height, and only when it has actually moved. */
function reportKeyboardInset(
  scope: RichMarkdownEditorScope,
  source: RichMarkdownKeyboardInsetReader
) {
  const rounded = Math.round(source.measure())
  if (rounded === scope.lastInset) {
    return
  }
  scope.lastInset = rounded
  post(scope, { type: 'keyboardInset', bottom: rounded })
}

/**
 * Reports how much of the viewport the keyboard covers, while there is a source that knows.
 *
 * Inside the WebView that is `visualViewport`, because native `Keyboard` events under-report a
 * WebView's covered area and the host's bar has to clear it. A host with no source — a page, whose
 * screen measures the same viewport with the same formula — is told nothing, rather than lifting
 * its own layout twice.
 */
export function startKeyboardInset(scope: RichMarkdownEditorScope) {
  const source = scope.keyboardInsetSource()
  if (!source) {
    return
  }
  const report = () => reportKeyboardInset(scope, source)
  scope.removeKeyboardInset = source.observe(report)
  report()
}

export function stopKeyboardInset(scope: RichMarkdownEditorScope) {
  scope.removeKeyboardInset?.()
  scope.removeKeyboardInset = null
}
