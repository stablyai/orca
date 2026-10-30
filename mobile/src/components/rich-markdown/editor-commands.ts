import { emitChange, syncTaskCheckboxesDisabled } from './editor-content'
import {
  rememberSelection,
  restoreRememberedSelection,
  restoreSelectionOrEnd,
  wrapSelection
} from './editor-selection'
import { editorElement } from './editor-surface'
import { isSafeUrl } from './markdown-escaping'
import type { MobileRichMarkdownCommand } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorScope } from './document-scope'
import type { RichMarkdownUrlPromptKind } from './document-host-seams'

const TASK_LIST_HTML =
  '<ul data-type="taskList"><li data-checked="false"><label contenteditable="false">' +
  '<input type="checkbox" /></label><div><p>Task</p></div></li></ul>'

const CODE_BLOCK_HTML = '<pre data-language=""><code>code</code></pre><p><br></p>'

function exec(scope: RichMarkdownEditorScope, command: string, value?: string) {
  scope.getDocument().execCommand(command, false, value)
}

// Reject command if host replaced content while URL prompt waited; generation/caret must still match user’s original target.
function acceptsCommands(scope: RichMarkdownEditorScope, generation: number): boolean {
  return (
    !scope.stopped &&
    scope.editable &&
    scope.documentGeneration === generation &&
    editorElement(scope).getAttribute('contenteditable') === 'true'
  )
}

// Link/Image await page URL modal; while waiting host may replace/lock/stop document, so capture generation and revalidate after answer.
// Save caret before modal takes focus and restore after; execCommand without selection inserts nothing. Reading generation here equals runCommand’s read because no yield intervenes.
async function insertUrl(
  scope: RichMarkdownEditorScope,
  kind: RichMarkdownUrlPromptKind,
  command: 'createLink' | 'insertImage'
) {
  const generation = scope.documentGeneration
  rememberSelection(scope)
  const url = await scope.promptForUrl(kind)
  if (url && isSafeUrl(url) && acceptsCommands(scope, generation)) {
    restoreRememberedSelection(scope)
    exec(scope, command, url)
  }
}

// Use record over command union so contract additions fail compile until handled.
const COMMANDS: Record<
  MobileRichMarkdownCommand,
  (scope: RichMarkdownEditorScope) => void | Promise<void>
> = {
  paragraph: (scope) => exec(scope, 'formatBlock', 'p'),
  heading1: (scope) => exec(scope, 'formatBlock', 'h1'),
  heading2: (scope) => exec(scope, 'formatBlock', 'h2'),
  heading3: (scope) => exec(scope, 'formatBlock', 'h3'),
  bold: (scope) => exec(scope, 'bold'),
  italic: (scope) => exec(scope, 'italic'),
  strike: (scope) => exec(scope, 'strikeThrough'),
  bulletList: (scope) => exec(scope, 'insertUnorderedList'),
  orderedList: (scope) => exec(scope, 'insertOrderedList'),
  taskList: (scope) => exec(scope, 'insertHTML', TASK_LIST_HTML),
  quote: (scope) => exec(scope, 'formatBlock', 'blockquote'),
  inlineCode: (scope) => wrapSelection(scope, 'code'),
  codeBlock: (scope) => exec(scope, 'insertHTML', CODE_BLOCK_HTML),
  link: (scope) => insertUrl(scope, 'link', 'createLink'),
  image: (scope) => insertUrl(scope, 'image', 'insertImage')
}

// Restore caret taken by toolbar; emit change after execCommand because it raises no input event. Await only URL commands so other thirteen remain synchronous.
export async function runCommand(
  scope: RichMarkdownEditorScope,
  command: MobileRichMarkdownCommand
) {
  const generation = scope.documentGeneration
  if (!acceptsCommands(scope, generation)) {
    return
  }
  restoreSelectionOrEnd(scope)
  const pending = COMMANDS[command]?.(scope)
  if (pending) {
    await pending
    // Recheck after wait so stale edit cannot emit under newly replaced generation.
    if (!acceptsCommands(scope, generation)) {
      return
    }
  }
  syncTaskCheckboxesDisabled(scope)
  emitChange(scope)
}
