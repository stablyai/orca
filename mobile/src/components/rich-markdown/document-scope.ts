import {
  clearWindowTimer,
  postToReactNativeWebView,
  promptWindowForUrl,
  windowDocument,
  windowSelection,
  windowVisualViewportInset,
  type RichMarkdownEditorHost,
  type RichMarkdownEditorHostSeams
} from './document-host-seams'
export type {
  RichMarkdownEditorApi,
  RichMarkdownEditorDocument,
  RichMarkdownEditorHost,
  RichMarkdownEditorHostSeams
} from './document-host-seams'

/**
 * The state one editor document shares across its modules.
 *
 * Every mutable binding the hand-written script declared is here, because a module's own `let`
 * would be shared by every document on the page: the second mount would inherit the first's
 * generation, its remembered caret and its last reported inset (ruling 21). One object per call,
 * built by the factory, so two editors on one page are two editors.
 */
export type RichMarkdownEditorState = {
  /** The editable surface, read once when the document starts. */
  editor: HTMLElement | null
  /** `editor-content`: the markdown the document last rendered or serialized. */
  lastMarkdown: string
  /**
   * `editor-content`: the pending input timer, cleared before every content replacement.
   *
   * Nothing schedules it today — the change message is posted straight from the input listener —
   * and it is kept because the clear is what a debounce would need and costs nothing without one.
   */
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

/** The document's whole scope: its state, and the seams to whatever is hosting it. */
export type RichMarkdownEditorScope = RichMarkdownEditorState & RichMarkdownEditorHostSeams

/** The initial values, which are the ones the script's own declarations carried. */
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

/** The seams' defaults: the window reads and writes the script already did. */
function createRichMarkdownEditorHostSeams(): RichMarkdownEditorHostSeams {
  return {
    postToHost: postToReactNativeWebView,
    promptForUrl: promptWindowForUrl,
    keyboardInsetSource: windowVisualViewportInset,
    clearTimer: clearWindowTimer,
    getSelection: windowSelection,
    getDocument: windowDocument
  }
}

export function createRichMarkdownEditorScope(
  host: RichMarkdownEditorHost = {}
): RichMarkdownEditorScope {
  const named = Object.fromEntries(Object.entries(host).filter(([, hook]) => hook !== undefined))
  return {
    ...createRichMarkdownEditorState(),
    ...createRichMarkdownEditorHostSeams(),
    ...named
  }
}
