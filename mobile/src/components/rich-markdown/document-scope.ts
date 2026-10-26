import {
  clearWindowTimer,
  windowDocument,
  windowSelection,
  type RichMarkdownEditorHost,
  type RichMarkdownEditorHostSeams
} from './document-host-seams'
export type {
  RichMarkdownEditorApi,
  RichMarkdownEditorDocument,
  RichMarkdownEditorHost,
  RichMarkdownEditorHostSeams
} from './document-host-seams'

// Own all mutable editor state per factory call; module let would leak generation, caret and inset between overlapping mounts (ruling 21).
export type RichMarkdownEditorState = {
  /** The editable surface, read once when the document starts. */
  editor: HTMLElement | null
  /** `editor-content`: the markdown the document last rendered or serialized. */
  lastMarkdown: string
  // Keep pending-input timer cleared on content replacement; currently unscheduled, but retained cancellation supports future debounce.
  inputTimer: number | null
  /** `editor-content`: the host's generation, echoed back on every change so it can drop stale ones. */
  documentGeneration: number
  /** `editor-content`: whether the surface accepts edits. */
  editable: boolean
  /** `editor-content`: set while the document rewrites itself, so its own input is not a change. */
  suppressInput: boolean
  /** `editor-selection`: the caret captured before a blur could drop it. */
  savedSelectionRange: Range | null
  /** `editor-selection`: whether the last blur was the document's own keyboard dismissal. */
  selectionDroppedOnBlur: boolean
  /** `keyboard-inset`: the last covered height posted, to suppress repeats. */
  lastInset: number
  /** `editor-listeners`: takes the four surface listeners off again, or null before them. */
  removeEditorListeners: (() => void) | null
  /** `keyboard-inset`: takes the viewport's two listeners off again, or null before them. */
  removeKeyboardInset: (() => void) | null
  /** `create-rich-markdown-editor-document`: whether the host has taken this document down. */
  stopped: boolean
}

/** The document's whole scope: its state, and the seams to the page that mounted it. */
export type RichMarkdownEditorScope = RichMarkdownEditorState & RichMarkdownEditorHostSeams

// Initialize per-document state to native script’s original defaults.
function createRichMarkdownEditorState(): RichMarkdownEditorState {
  return {
    editor: null,
    lastMarkdown: '',
    inputTimer: null,
    documentGeneration: 0,
    editable: true,
    suppressInput: false,
    savedSelectionRange: null,
    selectionDroppedOnBlur: false,
    lastInset: -1,
    removeEditorListeners: null,
    removeKeyboardInset: null,
    stopped: false
  }
}

export function createRichMarkdownEditorScope(
  host: RichMarkdownEditorHost
): RichMarkdownEditorScope {
  return {
    ...createRichMarkdownEditorState(),
    clearTimer: host.clearTimer ?? clearWindowTimer,
    getSelection: host.getSelection ?? windowSelection,
    getDocument: host.getDocument ?? windowDocument,
    root: host.root ?? null,
    postToHost: host.postToHost,
    promptForUrl: host.promptForUrl,
    keyboardInsetSource: host.keyboardInsetSource
  }
}
