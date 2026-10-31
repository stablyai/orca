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

// Observe/post keyboard cover only when source exists; page omits source because screen measures same viewport and duplicate report would double-lift layout.
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
