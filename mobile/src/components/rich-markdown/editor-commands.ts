import { emitChange, syncTaskCheckboxesDisabled } from './editor-content'
import { restoreSelectionOrEnd, wrapSelection } from './editor-selection'
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

/**
 * The two commands that need a URL the document does not have.
 *
 * A promise because the answer is a dialog: inside the WebView that is `window.prompt`, and on a
 * page it is a modal the host renders, which cannot answer before it has been shown.
 */
async function insertUrl(
  scope: RichMarkdownEditorScope,
  kind: RichMarkdownUrlPromptKind,
  command: 'createLink' | 'insertImage'
) {
  const url = await scope.promptForUrl(kind)
  if (url && isSafeUrl(url)) {
    exec(scope, command, url)
  }
}

/**
 * Every toolbar command, by name.
 *
 * A record over the contract's union rather than a chain of comparisons, so a command added to the
 * contract fails to compile until the document answers it.
 */
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

/**
 * One toolbar command against the current selection.
 *
 * The caret is restored first because the toolbar is outside the document and pressing it took the
 * focus; the change is emitted afterwards because `execCommand` rewrites the markup without
 * raising an input event the listeners would see.
 *
 * Awaited only where a command actually waits, so the thirteen that do not stay one synchronous
 * act from the host's call to the change it produces.
 */
export async function runCommand(
  scope: RichMarkdownEditorScope,
  command: MobileRichMarkdownCommand
) {
  if (!scope.editable || editorElement(scope).getAttribute('contenteditable') !== 'true') {
    return
  }
  restoreSelectionOrEnd(scope)
  const pending = COMMANDS[command]?.(scope)
  if (pending) {
    await pending
  }
  syncTaskCheckboxesDisabled(scope)
  emitChange(scope)
}
