import type {
  MobileRichMarkdownCommand,
  MobileRichMarkdownEditorMessage
} from '../mobile-rich-markdown-editor-contract'

// Page supplies message/URL-prompt/keyboard seams: window.ReactNativeWebView is shell bridge and window.prompt returns null in both shells; other seams default to live window reads.

/** Which URL a command is asking the user for. */
export type RichMarkdownUrlPromptKind = 'link' | 'image'

// Keyboard cover source/listener is null on page: screen measures same viewport and duplicate report would double-lift bar.
export type RichMarkdownKeyboardInsetReader = {
  /** The height the keyboard covers right now, in CSS pixels. */
  measure: () => number
  /** Calls back when the covered height may have moved, handing back its removal. */
  observe: (onChange: () => void) => () => void
}

/** The five things the page can ask a running document to do. */
export type RichMarkdownEditorApi = {
  setMarkdown: (markdown: string, generation: number) => void
  setEditable: (editable: boolean) => void
  runCommand: (command: MobileRichMarkdownCommand) => Promise<void>
  currentMarkdown: () => string
  dismissKeyboard: () => void
}

/** A running document: what the page sends into it, and `stop`, which the page's dispose calls. */
export type RichMarkdownEditorDocument = {
  send: RichMarkdownEditorApi
  stop: () => void
}

export type RichMarkdownEditorHostSeams = {
  /** `host-bridge`: where a message for the host goes. */
  postToHost: (message: MobileRichMarkdownEditorMessage) => void
  /** `editor-commands`: the URL the Link and Image commands insert, or null when cancelled. */
  promptForUrl: (kind: RichMarkdownUrlPromptKind) => Promise<string | null>
  /** `keyboard-inset`: the covered height and its changes, or null when the page measures it. */
  keyboardInsetSource: () => RichMarkdownKeyboardInsetReader | null
  /** `editor-content`: cancels the pending input timer. */
  clearTimer: (handle: number | null) => void
  /** `editor-selection`: the live selection this document's caret lives in. */
  getSelection: () => Selection | null
  /** `editor-commands`, `editor-selection`: the document ranges, elements and `execCommand` come from. */
  getDocument: () => Document
  // Scope editor-surface lookup to mount root because transitions overlap hosts with same id; null reads whole document at call time.
  root: ParentNode | null
}

/** What the page hands the document: the host-facing seams always, the window reads if it wants. */
export type RichMarkdownEditorHost = Pick<
  RichMarkdownEditorHostSeams,
  'postToHost' | 'promptForUrl' | 'keyboardInsetSource'
> &
  Partial<Pick<RichMarkdownEditorHostSeams, 'clearTimer' | 'getSelection' | 'getDocument' | 'root'>>

// Export command prompt kind so page modal asks correct URL question.
export const RICH_MARKDOWN_URL_PROMPT_LABELS: Record<RichMarkdownUrlPromptKind, string> = {
  link: 'Link URL',
  image: 'Image URL'
}

export function clearWindowTimer(handle: number | null) {
  window.clearTimeout(handle ?? undefined)
}

export function windowSelection() {
  return window.getSelection()
}

/** The page the document's elements and ranges are in, read at the call like the other seams. */
export function windowDocument() {
  return document
}
