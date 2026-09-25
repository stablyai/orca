import type {
  TerminalDocumentTerminal,
  TerminalDocumentWebglAddon
} from './document-terminal-shape'

/**
 * The ten seams between the document and whatever is hosting it, as the document's own
 * defaults, and the root its elements are read from. `postToHost` is read twice; `createTerminal`,
 * the two addon builders, `installErrorReporter`, `paintDocumentBackground`, `installHostTransport`,
 * `hasEngine` and `observeViewport` once each; `viewportRect` at every size bound and client-point
 * mapping. The root is read through one accessor, at the ten element reads.
 *
 * Inside the WebView the host is React Native and the engine is an IIFE that hangs its
 * constructors off `window`; on the page the host is the component that mounted these modules and
 * the engine is an import. Each function below is the window read or write the document already
 * did, kept at call time rather than captured when the script is parsed, and the scope carries it
 * as a field the page assigns over.
 */

/** What a thrown value can be here: an Error-shaped object, a string, or nothing. */
export type TerminalEngineError = string | null | undefined | { message?: unknown }

/** The box the document's grid is shown in: client coordinates of its top-left, and its size. */
export type TerminalDocumentViewportRect = {
  left: number
  top: number
  width: number
  height: number
}

/** The document's runtime error reporter, taking the window error handler's own arguments. */
export type TerminalDocumentErrorReporter = (
  message: string | (Event & { message?: unknown }),
  source?: string,
  line?: number,
  column?: number,
  error?: TerminalEngineError
) => void

/** A frame from the host, as its transport delivers it: JSON text from a bridge, or the object. */
export type TerminalDocumentHostFrame = string | Record<string, unknown> | undefined

/**
 * The ten host seams, kept apart from the state because the host sets them once when it builds
 * the scope, before the start sequence runs, and no module writes them afterwards.
 */
export type TerminalDocumentHostSeams = {
  /** `host-notify`, `viewport-transform`: where a message for the host goes. */
  postToHost: (message: Record<string, unknown>) => void
  /** `terminal-init`: builds the xterm terminal. */
  createTerminal: (options: Record<string, unknown>) => TerminalDocumentTerminal
  /** `terminal-init`: builds the unicode11 addon, or answers null when the host has none. */
  createUnicode11Addon: () => TerminalDocumentWebglAddon | null
  /** `webgl-recovery`: builds the WebGL addon, or answers null when the host has none. */
  createWebglAddon: () => TerminalDocumentWebglAddon | null
  /** `host-notify`: installs the document's runtime error reporter with the host. */
  installErrorReporter: (report: TerminalDocumentErrorReporter) => () => void
  /** `host-notify`: the host's capture buffer, which a report quotes and the reporter appends to. */
  capturedEngineErrors: () => string[]
  /** `terminal-theme`: paints the terminal's background behind the grid. */
  paintDocumentBackground: (background: string) => void
  /** `message-bridge`: installs the host's transport for the frames it sends, handing back its removal. */
  installHostTransport: (receive: (frame: TerminalDocumentHostFrame) => void) => () => void
  /** `message-bridge`: whether the engine is here, which is what readiness is reported on. */
  hasEngine: () => boolean
  /** Every fit, pan, scroll and overlay bound, and every client point mapped into the grid. */
  viewportRect: () => TerminalDocumentViewportRect
  /** `fit-scale`: calls back when that box changes size, handing back its removal. */
  observeViewport: (onChange: () => void) => () => void
  /**
   * Where this document's elements are: the node its markup was planted in, or null for the page
   * the document is running in.
   *
   * The last thing two documents on one page shared. The ids are in the markup every host plants,
   * so a page-wide read found whichever host came first in the tree — and two documents at once is
   * not a corner on the page, because a stack transition keeps the outgoing screen mounted while
   * the incoming one starts. Inside the WebView the document *is* the page, so it says nothing and
   * gets the whole of it; on the page it names the host element the mount planted the markup in.
   *
   * Null rather than `document` as the default, because this is the one seam whose value is data:
   * a default of `document` is read when the scope is built rather than when an element is, and
   * the rule for every seam above it is that the window read happens at the call. The accessor
   * resolves it, so the read stays where the other ten are.
   */
  root: ParentNode | null
}

/**
 * What a host may hand the document instead of a window read.
 *
 * Every seam has a default, so a host names only the ones it owns differently: inside the WebView
 * that is none of them, and the page names all eleven. Absent and present-but-undefined mean the same
 * thing, which is why the scope's spread filters rather than trusting key order.
 */
export type TerminalDocumentHost = Partial<TerminalDocumentHostSeams>

/**
 * A running document: the two things a host can do to one it has started.
 *
 * `send` is the router the WebView already reached through its message listener, which the page
 * calls directly. `stop` runs every module's stop and takes back the frames the document is owed;
 * the page's dispose calls it, and the WebView never does.
 */
export type TerminalDocument = {
  send: (message: Record<string, unknown>) => void
  stop: () => void
}

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void }
    Unicode11Addon?: { Unicode11Addon: new () => TerminalDocumentWebglAddon }
    WebglAddon?: { WebglAddon?: new () => TerminalDocumentWebglAddon }
    Terminal?: unknown
    /**
     * The shell's capture buffer, which its `<head>` opens before the engine script runs.
     *
     * It stays a global there because it is older than any document: an engine that throws while it
     * loads has to be captured by something the document has not started yet, and the first report
     * quotes it. The document reaches it through a seam, so a page's mount holds its own instead.
     */
    __engineErrors?: string[]
  }
  const Terminal: new (options: Record<string, unknown>) => TerminalDocumentTerminal
}

export function postToReactNativeWebView(message: Record<string, unknown>) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message))
  }
}

export function createEngineTerminal(options: Record<string, unknown>) {
  return new Terminal(options)
}

export function createEngineUnicode11Addon() {
  return window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon
    ? new window.Unicode11Addon.Unicode11Addon()
    : null
}

export function createEngineWebglAddon() {
  return window.WebglAddon && window.WebglAddon.WebglAddon
    ? new window.WebglAddon.WebglAddon()
    : null
}

/**
 * The WebView's own background: the document owns `html` and `body` there, and the terminal's
 * theme is the page's colour. A page mounting these modules owns neither, so this is a field —
 * painting the application's roots would recolour every screen the shell can show, and leave them
 * recoloured after the terminal is gone.
 */
export function paintWindowDocumentBackground(background: string) {
  document.documentElement.style.background = background
  document.body.style.background = background
}

/**
 * The WebView's own installation: the document owns that page, so taking `window.onerror` is
 * taking nothing from anyone. A page mounting these modules must not, which is why this is a
 * field rather than a statement.
 *
 * It hands back its own undo, because ruling 20 makes the install a per-mount act and the page's
 * override is a listener that has to come off again.
 */
export function installWindowErrorReporter(report: TerminalDocumentErrorReporter) {
  window.onerror = report
  return function () {
    window.onerror = null
  }
}

/**
 * The WebView's transport: the shell posts frames as `message` events, on `window` from the
 * injected bridge and on `document` from Android's dispatch, so the document listens for both.
 *
 * A page has no such frames — its host holds the document's `send` and calls it — and listening
 * there would take the shell's own messages, which belong to the page's bridge and not to a
 * terminal. So this is a field, and the page's transport installs nothing.
 */
export function installWindowHostTransport(receive: (frame: TerminalDocumentHostFrame) => void) {
  const listener = (event: Event & { data?: TerminalDocumentHostFrame }) => {
    receive(event.data)
  }
  window.addEventListener('message', listener)
  document.addEventListener('message', listener)
  return function () {
    window.removeEventListener('message', listener)
    document.removeEventListener('message', listener)
  }
}

/** The shell's buffer, which its `<head>` has already declared by the time the document runs. */
export function windowCapturedEngineErrors() {
  window.__engineErrors = window.__engineErrors ?? []
  return window.__engineErrors
}

/**
 * Whether the engine is here, as the WebView can know it: the engine is an IIFE that hangs
 * `Terminal` off `window`, and a script tag that failed to load leaves it undefined, which is the
 * one failure the document reports before it has run anything.
 *
 * On the page the engine is an import that already resolved by the time the document is built, so
 * the page answers yes rather than reading a global it never writes.
 *
 * `!== undefined` rather than a `typeof` guard: the global is declared optional, so the lint rule
 * that forbids the guard is right that there is nothing to guard against here.
 */
export function windowHasEngine() {
  return window.Terminal !== undefined
}

/**
 * The WebView's viewport: there the window is the terminal frame. On the page the window is the
 * whole page, taller than the frame by the header and dock, so the page answers with its host.
 */
export function windowViewportRect(): TerminalDocumentViewportRect {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

/** The WebView's frame changes size exactly when its window does. */
export function observeWindowViewport(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return function () {
    window.removeEventListener('resize', onChange)
  }
}

/**
 * One of a document's own elements, by the id its markup gives it.
 *
 * Every element read goes through here, so `root` is the only place a host says where its document
 * is. `querySelector` rather than `getElementById`, because a root may be an element: the page's
 * host carries the markup, and only the WebView's document is a whole document.
 *
 * A ternary rather than `??`: the emitted document is transformed for an older target, where `??`
 * costs a temporary that the reader of the script has to step over.
 */
export function elementInRoot(root: ParentNode | null, id: string) {
  const within = root === null ? document : root
  return within.querySelector<HTMLElement>(`#${id}`)
}

/** An element a target can be tested against; a method, so a real element satisfies it. */
export type TerminalDocumentTargetContainer = { contains(other: EventTarget | null): boolean }

/**
 * Whether an event on the page is this document's to read.
 *
 * The counterpart of `elementInRoot` for events rather than elements, and for the same reason: a
 * listener on `document` is page-wide, so with two documents on one page each is handed the other's
 * touches. Without this, a pinch in one terminal drops the selection of the terminal nobody
 * touched, because the dispatcher's two-finger branch answers before it looks at the target.
 *
 * Asked once at the top of each document-level handler rather than inside its branches, because
 * every branch has the same answer and a branch added later would not remember to ask.
 *
 * Inside the WebView the document *is* the page (`root === null`), so this says yes to everything
 * and the native document's dispatcher is unchanged.
 */
export function eventTargetInRoot(
  root: TerminalDocumentTargetContainer | null,
  target: EventTarget | null
) {
  if (root === null) {
    return true
  }
  return target !== null && root.contains(target)
}

/**
 * This document's own fingers out of a page-wide touch list.
 *
 * `eventTargetInRoot` settles whose event it is; the list inside the event is a second page-wide
 * read, because `e.touches` is every finger on the screen and not the ones on this terminal. So a
 * finger resting in the other document makes this one see two touches and latch a pinch, or makes
 * `length === 0` false on touchend so the tap it should fire never does — the same defect one level
 * in, and every count and index in the dispatcher and the surface gestures reads through here.
 *
 * `root === null` is the WebView, whose fingers are all its own: the list comes back untouched, so
 * the native document allocates nothing on a path that runs at frame rate.
 *
 * `ArrayLike` rather than `TouchList`: the filtered list is a real array, and both are read the
 * only two ways the document reads either, by `length` and by index.
 */
export function touchesInRoot(
  root: TerminalDocumentTargetContainer | null,
  touches: ArrayLike<Touch>
): ArrayLike<Touch> {
  if (root === null) {
    return touches
  }
  const mine: Touch[] = []
  for (let i = 0; i < touches.length; i++) {
    if (eventTargetInRoot(root, touches[i].target)) {
      mine.push(touches[i])
    }
  }
  return mine
}
