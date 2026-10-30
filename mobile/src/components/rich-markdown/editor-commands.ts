import { emitChange } from './editor-content'
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

function drawsContent(node: Node): boolean {
  return (
    /[^ \t\r\n]/.test(node.textContent ?? '') ||
    ((node instanceof Element || node instanceof DocumentFragment) &&
      node.querySelector('img') !== null) ||
    (node instanceof Element && node.tagName.toLowerCase() === 'img')
  )
}

// Native insertHTML merges the fragment's first block into a block with content before the caret, so the PRE becomes prose.
function caretFollowsContent(scope: RichMarkdownEditorScope): boolean {
  const selection = scope.getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return false
  }
  const caret = selection.getRangeAt(0)
  const editor = editorElement(scope)
  if (caret.startContainer === editor) {
    const previous = editor.childNodes.item(caret.startOffset - 1)
    return (
      previous !== null &&
      !(previous instanceof Element && previous.closest('table')) &&
      drawsContent(previous)
    )
  }
  const anchor =
    caret.startContainer instanceof Element
      ? caret.startContainer
      : caret.startContainer.parentElement
  if (!anchor || !editor.contains(anchor) || anchor.closest('table, pre')) {
    return false
  }
  const block = anchor.closest('p, div, li, h1, h2, h3, h4, h5, h6, blockquote')
  if (!block || block === editor || !editor.contains(block)) {
    return false
  }
  const before = scope.getDocument().createRange()
  before.setStart(block, 0)
  before.setEnd(caret.startContainer, caret.startOffset)
  return drawsContent(before.cloneContents())
}

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

function canFormatCodeBlock(scope: RichMarkdownEditorScope): boolean {
  const selection = scope.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return true
  }
  const range = selection.getRangeAt(0)
  return !Array.from(
    editorElement(scope).querySelectorAll(
      'blockquote,ul,ol,table,img,input,hr,[contenteditable="false"]'
    )
  ).some((node) => range.intersectsNode(node.closest('p,h1,h2,h3,h4,h5,h6,pre') ?? node))
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
  codeBlock: (scope) => {
    if (scope.getSelection()?.isCollapsed === false) {
      exec(scope, 'formatBlock', 'pre')
    } else {
      // A leading break ends the caret's line first; the stray root <br> it leaves saves as nothing.
      exec(
        scope,
        'insertHTML',
        caretFollowsContent(scope) ? `<br>${CODE_BLOCK_HTML}` : CODE_BLOCK_HTML
      )
    }
  },
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
  if (command === 'codeBlock' && !canFormatCodeBlock(scope)) {
    return
  }
  const pending = COMMANDS[command]?.(scope)
  if (pending) {
    await pending
    // Recheck after wait so stale edit cannot emit under newly replaced generation.
    if (!acceptsCommands(scope, generation)) {
      return
    }
  }
  emitChange(scope)
}
