import { DEFAULT_TERMINAL_THEME } from '../terminal-webview-html/theme'
import {
  createEngineTerminal,
  createEngineUnicode11Addon,
  createEngineWebglAddon,
  installWindowErrorReporter,
  installWindowHostTransport,
  paintWindowDocumentBackground,
  postToReactNativeWebView,
  windowCapturedEngineErrors,
  windowHasEngine,
  observeWindowViewport,
  windowViewportRect,
  type TerminalDocumentHost,
  type TerminalDocumentHostSeams
} from './document-host-seams'
import type {
  TerminalDocumentDisposable,
  TerminalDocumentTerminal,
  TerminalDocumentTheme,
  TerminalDocumentWebglAddon,
  TerminalInitialOscLink
} from './document-terminal-shape'
import type { TerminalMouseGesture } from './mouse-click-drag'
import type { TerminalTouchState } from './surface-touch-gestures'
import type { TerminalTouchDispatch } from './tap-dispatch'
import type { TerminalDocumentThemeMessage } from './terminal-theme'

// Re-exported so every module that reads the scope names one import for both: the engine's shape is
// a separate file for length, not a second place to look.
export type * from './document-terminal-shape'
export type { TerminalDocumentHost, TerminalDocumentHostSeams } from './document-host-seams'
/**
 * The state one terminal document shares across its modules.
 *
 * A field is here because more than one module writes it, and the module that owns it is named
 * beside it. State written only inside the module that declares it stays a `let` there, however
 * often it is written: `terminalDataRepliesEnabled` is written from four places and all four are in
 * `query-reply`. A value nothing writes is that module's own `const`, not a field.
 *
 * One object per document, built by the call rather than shared by the modules, which is what lets
 * two terminals sit on one page without one of them reading the other's state.
 */

export type TerminalDocumentState = {
  /** `terminal-init`: the live xterm terminal, or null before the first init. */
  term: TerminalDocumentTerminal | null
  /** `viewport-transform`: the surface's pan offset, in viewport pixels. */
  panX: number
  panY: number
  /** `terminal-init`: bumped on every re-init, so a late callback can tell it is stale. */
  terminalGeneration: number
  /** `term-observers`: xterm listener handles to dispose when the terminal is replaced. */
  termObserverDisposables: TerminalDocumentDisposable[]
  /** `terminal-init`: the row count the last init or reflow settled on. */
  initRows: number
  /** `webgl-recovery`: the loaded WebGL addon, or null on the DOM renderer. */
  webglAddon: TerminalDocumentWebglAddon | null
  /** `webgl-recovery`: the pending single retry after a context loss. */
  webglRecoveryTimer: ReturnType<typeof setTimeout> | null
  /** `terminal-theme`: the theme the host last sent, replayed on visibility. */
  terminalThemeInput: TerminalDocumentThemeMessage
  /** `wheel-scroll`: sub-line wheel travel carried between events; reset by a touch scroll. */
  wheelAccumDeltaY: number
  /** `terminal-theme`: the built-in theme, and the fallback for every slot a host theme omits. */
  defaultTheme: TerminalDocumentTheme
  /** `terminal-theme`: the host theme normalised against the built-in one. */
  terminalTheme: TerminalDocumentTheme
  /** `terminal-theme`: the contrast floor in force, published or derived from the background. */
  terminalMinimumContrastRatio: number
  /** `selection-overlay`: OSC 8 links captured from scrollback before xterm replayed it. */
  initialOscLinks: TerminalInitialOscLink[]
  /** `selection-overlay`: how far the captured rows have scrolled out of the buffer. */
  initialOscLinkRowOffset: number
  /** `mode-mirroring`: the last mode set published to the host, to suppress repeats. */
  lastEmittedModes: TerminalDocumentModes
  /** `terminal-init`: whether the terminal has ever reached ready. */
  everReady: boolean
  /** `mouse-mode-decset-scan`: the tail of the last chunk, in case a DECSET straddles two writes. */
  mouseModeScanTail: string
  /** `mouse-mode-decset-scan`: the mouse tracking mode the TUI last asked for. */
  trackedMouseTrackingMode: string
  /** `mouse-mode-decset-scan`: whether the TUI asked for SGR (1006) mouse reports. */
  sgrMouseMode: boolean
  /** `mouse-mode-decset-scan`: whether the TUI asked for SGR pixel (1016) mouse reports. */
  sgrMousePixelsMode: boolean
  /** `text-scaling`: the scroll indicator's hide timer. */
  scrollIndicatorHideTimer: ReturnType<typeof setTimeout> | null
  /** `viewport-transform`: host message ids already handled, to drop repeats. */
  handledMessageIds: number[]
  /** `text-scaling`: the text scale the user picked, as a preset index. */
  currentTextScale: number
  /** `text-scaling`: the font stack xterm renders with. */
  terminalFontFamily: string
  /** `terminal-init`: whether the first live chunk since init is still pending. */
  firstDataPending: boolean
  /** `terminal-init`: whether the replayed snapshot was an alternate screen. */
  activeAltScreenSnapshot: boolean
  /** `fit-scale`: the fit scale the document committed. */
  currentScale: number
  /** `text-scaling`: the pinch zoom the user applied on top of the fit scale. */
  userScale: number
  /** `write-queue`: whether a chunk ended mid-selector, so the next one starts inside it. */
  statusDotPendingSelector: boolean
  /** `write-queue`: chunks and boundaries waiting for xterm. */
  writeQueue: TerminalWriteQueueEntry[]
  /** `write-queue`: how far the queue has been consumed, before compaction. */
  writeQueueHead: number
  /** `write-queue`: whether a write is parsing right now. */
  writesDraining: boolean
  /** `write-queue`: callbacks waiting for the queue to empty. */
  afterDrainCallbacks: (() => void)[]
  /** `terminal-init`: whether the terminal has been initialised. */
  ready: boolean
  /** `normal-buffer-smooth-scroll`: sub-row scroll travel not yet committed to xterm. */
  smoothScrollOffsetY: number
  /** `normal-buffer-smooth-scroll`: scroll travel waiting for the next frame. */
  pendingNormalScrollDeltaY: number
  /** `normal-buffer-smooth-scroll`: the frame request that will apply it, if one is pending. */
  normalScrollFrameId: number | null
  /** `selection-state-and-eviction`: the menu pill element. */
  selMenu: HTMLElement | null
  /** `selection-state-and-eviction`: the pill's copy button. */
  btnCopy: HTMLElement | null
  /** `selection-state-and-eviction`: the pill's select-all button. */
  btnSelAll: HTMLElement | null
  /** `selection-state-and-eviction`: the running edge-scroll timer. */
  edgeScrollTimer: ReturnType<typeof setInterval> | null
  /** `selection-state-and-eviction`: which way the edge scroll is going. */
  edgeScrollDir: number
  /** `selection-state-and-eviction`: where the dragging finger last was. */
  edgeScrollClientX: number
  /** `selection-state-and-eviction`: where the dragging finger last was. */
  edgeScrollClientY: number
  /** `selection-state-and-eviction`: whether captured OSC 8 rows may start shifting with eviction. */
  initialOscLinkEvictionReady: boolean
  /** `selection-overlay`: the overlay element that carries the handles and the menu pill. */
  selectionOverlay: HTMLElement | null
  /** `selection-overlay`: the selection's leading handle element. */
  handleStart: HTMLElement | null
  /** `selection-overlay`: the selection's trailing handle element. */
  handleEnd: HTMLElement | null
  /** `selection-overlay`: `navigate` or `select`. */
  selMode: string
  /** `selection-overlay`: the live selection, or null when there is none. */
  sel: TerminalDocumentSelection | null
  /** `selection-overlay`: the pending long-press timer. */
  longPressTimer: ReturnType<typeof setTimeout> | null
  /** `selection-overlay`: where the pending long press started. */
  longPressOrigin: TerminalDocumentTouchOrigin | null
  /** `selection-overlay`: the touch that may still resolve as a tap. */
  tapCandidate: TerminalDocumentTapCandidate | null
  /** `surface-swap`: the element xterm is currently mounted on. */
  surface: HTMLElement | null
  /** `surface-swap`: the terminal of a hidden replacement surface that has not committed. */
  pendingTerm: TerminalDocumentTerminal | null
  /** `surface-swap`: the terminal the committed surface is showing. */
  committedTerm: TerminalDocumentTerminal | null
  /** `surface-swap`: the surface the committed terminal is mounted on. */
  committedSurface: HTMLElement | null
  /** `surface-swap`: the hidden replacement surface, until it commits. */
  pendingSurface: HTMLElement | null
  /** `text-scaling`: the scroll indicator's track and its thumb. */
  scrollIndicator: HTMLElement | null
  scrollThumb: HTMLElement | null
  /** `query-reply`: whether the host asked for terminal data replies. */
  terminalDataRepliesEnabled: boolean
  /** `selection-state-and-eviction`: rows written since the terminal opened. */
  linesEverWritten: number
  /** `host-notify`: non-fatal reports already sent, against the flood cap. */
  nonFatalErrorNotifies: number
  /** `host-notify`: undoes the host's reporter install, or null before one. */
  uninstallErrorReporter: (() => void) | null
  /** `message-bridge`: undoes the host transport's install, or null before one. */
  uninstallHostTransport: (() => void) | null
  /** `fit-scale`: takes the viewport refit's listener off again, or null before one. */
  removeViewportRefit: (() => void) | null
  /** `tap-dispatch`: takes its four document listeners off again, or null before them. */
  removeTapDispatch: (() => void) | null
  /** `webgl-recovery`: takes the visibility listener off again, or null before one. */
  removeWebglRecovery: (() => void) | null
  /** `fit-scale`: the generation of the retry loop; a bump abandons the one in flight. */
  fitRetryToken: number
  /** `mouse-click-drag`: the mouse gesture in progress, or null. */
  mouseGesture: TerminalMouseGesture | null
  /** `tap-dispatch`: what the document-level dispatcher has latched onto. */
  touchDispatch: TerminalTouchDispatch
  /** `surface-touch-gestures`: the surface touch, its velocity and its momentum frame. */
  touchGesture: TerminalTouchState
  /** Every animation frame the document has asked for and not yet run. */
  scheduledFrames: number[]
  /** Whether the document has been stopped, and so asks for no more frames. */
  framesStopped: boolean
}

/** The document's whole scope: its state, and the seams to whatever is hosting it. */
export type TerminalDocumentScope = TerminalDocumentState & TerminalDocumentHostSeams

/** The live selection; only the dragged handle is read outside the overlay slice. */
export type TerminalDocumentSelection = {
  anchor: { row: number; col: number }
  focus: { row: number; col: number }
  activeHandle: string | null
}

/** Where a press began, and which finger began it. */
export type TerminalDocumentTouchOrigin = { x: number; y: number; identifier: number }

/** A touch that may still resolve as a tap: its origin, its start time and its finger. */
export type TerminalDocumentTapCandidate = TerminalDocumentTouchOrigin & { t: number }

/** The terminal modes the host mirrors. */
export type TerminalDocumentModes = {
  bracketedPasteMode: boolean
  altScreen: boolean
  mouseTrackingMode: string
  sgrMouseMode: boolean
  sgrMousePixelsMode: boolean
}

/** One entry of the write queue: a chunk, a boundary callback, or a consumed slot. */
export type TerminalWriteQueueEntry = string | (() => void) | undefined

/**
 * The initial values, which are the ones the document's own declarations carried.
 *
 * A factory rather than a shared literal so a second document — a test, or a page that remounts —
 * starts from its own state instead of inheriting what the last one left.
 */

function createTerminalDocumentState(): TerminalDocumentState {
  return {
    term: null,
    panX: 0,
    panY: 0,
    terminalGeneration: 0,
    termObserverDisposables: [],
    initRows: 24,
    webglAddon: null,
    webglRecoveryTimer: null,
    terminalThemeInput: null,
    defaultTheme: DEFAULT_TERMINAL_THEME,
    terminalTheme: DEFAULT_TERMINAL_THEME,
    terminalMinimumContrastRatio: 3,
    initialOscLinks: [],
    initialOscLinkRowOffset: 0,
    lastEmittedModes: {
      bracketedPasteMode: false,
      altScreen: false,
      mouseTrackingMode: 'none',
      sgrMouseMode: false,
      sgrMousePixelsMode: false
    },
    everReady: false,
    mouseModeScanTail: '',
    trackedMouseTrackingMode: 'none',
    sgrMouseMode: false,
    sgrMousePixelsMode: false,
    scrollIndicatorHideTimer: null,
    handledMessageIds: [],
    currentTextScale: 1,
    terminalFontFamily: '',
    firstDataPending: false,
    activeAltScreenSnapshot: false,
    currentScale: 1,
    userScale: 1,
    statusDotPendingSelector: false,
    writeQueue: [],
    writeQueueHead: 0,
    writesDraining: false,
    afterDrainCallbacks: [],
    ready: false,
    smoothScrollOffsetY: 0,
    pendingNormalScrollDeltaY: 0,
    normalScrollFrameId: null,
    selMenu: null,
    btnCopy: null,
    btnSelAll: null,
    edgeScrollTimer: null,
    edgeScrollDir: 0,
    edgeScrollClientX: 0,
    edgeScrollClientY: 0,
    initialOscLinkEvictionReady: false,
    selectionOverlay: null,
    handleStart: null,
    handleEnd: null,
    selMode: 'navigate',
    sel: null,
    longPressTimer: null,
    longPressOrigin: null,
    tapCandidate: null,
    wheelAccumDeltaY: 0,
    surface: null,
    pendingTerm: null,
    committedTerm: null,
    committedSurface: null,
    pendingSurface: null,
    scrollIndicator: null,
    scrollThumb: null,
    terminalDataRepliesEnabled: false,
    linesEverWritten: 0,
    nonFatalErrorNotifies: 0,
    uninstallErrorReporter: null,
    uninstallHostTransport: null,
    removeViewportRefit: null,
    removeTapDispatch: null,
    removeWebglRecovery: null,
    fitRetryToken: 0,
    mouseGesture: null,
    touchDispatch: {
      mode: 'idle',
      touchId: null,
      touchIds: null,
      longPressFingerInsideOverlay: false
    },
    scheduledFrames: [],
    framesStopped: false,
    touchGesture: {
      lastX: 0,
      lastY: 0,
      lastTime: 0,
      velY: 0,
      accumDelta: 0,
      momentumId: null,
      isPinching: false,
      pinchDist: 0,
      pinchScale: 0,
      pinchSurfX: 0,
      pinchSurfY: 0
    }
  }
}

/** The seams' defaults: the window reads and writes the document already did. */
function createTerminalDocumentHostSeams(): TerminalDocumentHostSeams {
  return {
    postToHost: postToReactNativeWebView,
    createTerminal: createEngineTerminal,
    createUnicode11Addon: createEngineUnicode11Addon,
    createWebglAddon: createEngineWebglAddon,
    installErrorReporter: installWindowErrorReporter,
    capturedEngineErrors: windowCapturedEngineErrors,
    paintDocumentBackground: paintWindowDocumentBackground,
    installHostTransport: installWindowHostTransport,
    hasEngine: windowHasEngine,
    viewportRect: windowViewportRect,
    observeViewport: observeWindowViewport,
    root: null
  }
}

export function createTerminalDocumentScope(
  host: TerminalDocumentHost = {}
): TerminalDocumentScope {
  const named = Object.fromEntries(Object.entries(host).filter(([, hook]) => hook !== undefined))
  return { ...createTerminalDocumentState(), ...createTerminalDocumentHostSeams(), ...named }
}
