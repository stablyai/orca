import { blockMarkdown } from './html-block-markdown'
import { markdownToHtml } from './markdown-to-html'
import { post } from './host-bridge'
import { editorElement } from './editor-surface'
import type { RichMarkdownEditorScope } from './document-scope'

/** What the surface holds right now, as markdown: every block, blank ones dropped. */
export function currentMarkdown(scope: RichMarkdownEditorScope): string {
  return Array.from(editorElement(scope).childNodes)
    .map((node) => blockMarkdown(node))
    .filter((block) => block.trim().length > 0)
    .join('\n\n')
    .trimEnd()
}

/** A checkbox the user could move under a read-only document would record nothing, so it cannot. */
export function syncTaskCheckboxesDisabled(scope: RichMarkdownEditorScope) {
  editorElement(scope)
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((input) => {
      input.disabled = !scope.editable
    })
}

// Echo host generation unchanged for stale-change filtering; suppressInput excludes document’s own rewrites.
export function emitChange(scope: RichMarkdownEditorScope) {
  if (scope.suppressInput || !scope.editable) {
    return
  }
  scope.clearTimer(scope.inputTimer)
  const pendingGeneration = scope.documentGeneration
  scope.lastMarkdown = currentMarkdown(scope)
  post(scope, { type: 'change', markdown: scope.lastMarkdown, generation: pendingGeneration })
}

export function setMarkdown(scope: RichMarkdownEditorScope, markdown: string, generation: number) {
  scope.clearTimer(scope.inputTimer)
  scope.documentGeneration = Number(generation) || 0
  scope.suppressInput = true
  // Why: replacing innerHTML detaches the remembered caret's nodes.
  scope.savedSelectionRange = null
  scope.selectionDroppedOnBlur = false
  scope.lastMarkdown = String(markdown || '')
  editorElement(scope).innerHTML = markdownToHtml(scope, scope.lastMarkdown)
  syncTaskCheckboxesDisabled(scope)
  scope.suppressInput = false
}

// Cancel pending callback to release scope and prevent change after unmount/content replacement; currently nothing schedules timer, but cancellation must accompany future use.
export function stopEditorContent(scope: RichMarkdownEditorScope) {
  scope.clearTimer(scope.inputTimer)
  scope.inputTimer = null
}

export function setEditable(scope: RichMarkdownEditorScope, editable: boolean) {
  scope.editable = Boolean(editable)
  editorElement(scope).setAttribute('contenteditable', scope.editable ? 'true' : 'false')
  syncTaskCheckboxesDisabled(scope)
}
