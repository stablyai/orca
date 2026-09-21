import type {
  MobileRichMarkdownCommand,
  MobileRichMarkdownEditorMessage
} from '../mobile-rich-markdown-editor-contract'

/**
 * The six seams between the editor document and whatever is hosting it, as the document's own
 * defaults.
 *
 * Inside the WebView the host is React Native and every seam is the window read the hand-written
 * script already did; on the page the host is the component that mounted these modules, where
 * `window.ReactNativeWebView` is the *shell's* bridge and `window.prompt` is a dialog the shell's
 * WebView never shows. Each function below is that window read or write, kept at call time rather
 * than captured when the scope is built, and the scope carries it as a field the page assigns over.
 */

/** Which URL a command is asking the user for; the default turns it into the prompt's own text. */
export type RichMarkdownUrlPromptKind = 'link' | 'image'

/**
 * Where the covered height comes from, and what says it may have changed.
 *
 * Null when the host has no such measurement: inside the WebView that is a runtime without
 * `visualViewport`, and on the page it is every host, because the screen measures its own keyboard
 * and a second report would lift its bar twice.
 */
export type RichMarkdownKeyboardInsetReader = {
  /** The height the keyboard covers right now, in CSS pixels. */
  measure: () => number
  /** Calls back when the covered height may have moved, handing back its removal. */
  observe: (onChange: () => void) => () => void
}

/** The five things a host can ask a running document to do. */
export type RichMarkdownEditorApi = {
  setMarkdown: (markdown: string, generation: number) => void
  setEditable: (editable: boolean) => void
  runCommand: (command: MobileRichMarkdownCommand) => Promise<void>
  currentMarkdown: () => string
  dismissKeyboard: () => void
}

/**
 * A running document: what a host sends into one, and how it takes it down.
 *
 * `send` is the object the WebView reaches through its injected global and the page holds
 * directly. `stop` runs every module's stop; the page's dispose calls it, and the WebView never
 * does, because there the document outlives nothing.
 */
export type RichMarkdownEditorDocument = {
  send: RichMarkdownEditorApi
  stop: () => void
}

export type RichMarkdownEditorHostSeams = {
  /** `host-bridge`: where a message for the host goes. */
  postToHost: (message: MobileRichMarkdownEditorMessage) => void
  /** `editor-commands`: the URL the Link and Image commands insert, or null when cancelled. */
  promptForUrl: (kind: RichMarkdownUrlPromptKind) => Promise<string | null>
  /** `keyboard-inset`: the covered height and its changes, or null when the host has none. */
  keyboardInsetSource: () => RichMarkdownKeyboardInsetReader | null
  /** `editor-content`: cancels the pending input timer. */
  clearTimer: (handle: number | null) => void
  /** `editor-selection`: the live selection this document's caret lives in. */
  getSelection: () => Selection | null
  /** `editor-commands`, `editor-selection`: the document ranges, elements and `execCommand` come from. */
  getDocument: () => Document
}

/**
 * What a host may hand the document instead of a window read.
 *
 * Every seam has a default, so a host names only the ones it owns differently: inside the WebView
 * that is none of them. Absent and present-but-undefined mean the same thing, which is why the
 * scope's spread filters rather than trusting key order.
 */
export type RichMarkdownEditorHost = Partial<RichMarkdownEditorHostSeams>

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void }
    /** The native host's handle on the document, installed by the bundle's entry. */
    __orcaRichMarkdown?: RichMarkdownEditorApi
  }
}

export function postToReactNativeWebView(message: MobileRichMarkdownEditorMessage) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message))
  }
}

/** The labels the WebView's dialog carried, which is the whole of what the prompt kind means there. */
const URL_PROMPT_LABELS: Record<RichMarkdownUrlPromptKind, string> = {
  link: 'Link URL',
  image: 'Image URL'
}

/**
 * The WebView's own dialog, as a promise because a host that answers with a modal cannot answer
 * synchronously.
 *
 * Measured to return null in both shells — neither implements the delegate the dialog needs — so
 * the page passes its own and this default is what the native document keeps until it does.
 */
export function promptWindowForUrl(kind: RichMarkdownUrlPromptKind) {
  return Promise.resolve(window.prompt(URL_PROMPT_LABELS[kind]))
}

/** The WebView's own measurement: what `visualViewport` says the keyboard covers. */
export function windowVisualViewportInset(): RichMarkdownKeyboardInsetReader | null {
  const viewport = window.visualViewport
  if (!viewport) {
    return null
  }
  return {
    measure: () => Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop),
    observe: (onChange) => {
      viewport.addEventListener('resize', onChange)
      viewport.addEventListener('scroll', onChange)
      return () => {
        viewport.removeEventListener('resize', onChange)
        viewport.removeEventListener('scroll', onChange)
      }
    }
  }
}

export function clearWindowTimer(handle: number | null) {
  window.clearTimeout(handle ?? undefined)
}

export function windowSelection() {
  return window.getSelection()
}

/**
 * The page the document's elements and ranges are in.
 *
 * A function rather than a field, so the read happens where the other five do. The native document
 * *is* its page; a page mounting these modules hands back the same global object, and the host
 * element it planted the markup in is the only thing that differs.
 */
export function windowDocument() {
  return document
}
