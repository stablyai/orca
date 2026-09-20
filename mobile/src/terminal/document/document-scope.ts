import { terminalDefaultTheme, terminalTextScalePresets } from './document-constants'
import {
  createEngineTerminal,
  createEngineUnicode11Addon,
  createEngineWebglAddon,
  installWindowErrorReporter,
  paintWindowDocumentBackground,
  postToReactNativeWebView,
  type TerminalDocumentErrorReporter
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

// Re-exported so every module that reads the scope keeps naming one import for both: the split is
// about this file's length, not about a second place to look for the engine's shape.
export type * from './document-terminal-shape'
/**
 * The state the in-WebView terminal document shares across its parts.
 *
 * The document is one function scope: 2,758 lines around 100 `var` declarations, 57 of which are
 * written from more than one place. Moving its parts into modules is what lets the web page import
 * them instead of re-implementing them, and a variable assigned from another module cannot be an
 * import — assigning an imported binding is a syntax error. So the written ones become fields here,
 * and the group that owns each is named beside it.
 *
 * Two things keep a variable out of this table. One the script never assigns again is an ordinary
 * local. One both declared and assigned inside a single group is that module's own state, however
 * often it is written — `terminalDataRepliesEnabled` is written from four places and all four are
 * in `query-reply`, so it stays a `let` there.
 *
 * Declared, not merely written: while the rest of the document is still strings, a variable the
 * main slice declares is shared even when every use of it is in one group, because the declaration
 * has nowhere else to live yet. `webglRecoveryTimer` is that case. Those can migrate out of this
 * table when the flip makes the main slice modules too, and doing it before then would emit a
 * second declaration beside the one the slice still carries.
 *
 * The table grows one group at a time as C7.1 extracts them; a field arrives with its group.
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
  /** `runtime-constants`: the escape byte every report is prefixed with. */
  ESC: string
  /** `mode-mirroring`: the last mode set published to the host, to suppress repeats. */
  lastEmittedModes: TerminalDocumentModes
  /** `terminal-init`: whether the terminal has ever reached ready. */
  everReady: boolean
  /** `runtime-constants`: the C1 form of the control sequence introducer. */
  C1_CSI: string
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
  /** `text-scaling`: the narrowest grid a text-scale change will fit to. */
  MIN_FIT_COLS: number
  /** `text-scaling`: the smallest text-scale preset. */
  MIN_TEXT_SCALE: number
  /** `text-scaling`: the largest text-scale preset. */
  MAX_TEXT_SCALE: number
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
  /** `runtime-constants`: Claude's record dot, which iOS WebKit would otherwise promote to emoji. */
  CLAUDE_STATUS_DOT: string
  /** `runtime-constants`: the variation selector that forces the text glyph. */
  TEXT_PRESENTATION_SELECTOR: string
  /** `runtime-constants`: the variation selector that forces the emoji glyph. */
  EMOJI_PRESENTATION_SELECTOR: string
  /** `runtime-constants`: the dot with any trailing selectors, as one pattern. */
  CLAUDE_STATUS_DOT_PATTERN: RegExp
  /** `write-queue`: whether a chunk ended mid-selector, so the next one starts inside it. */
  statusDotPendingSelector: boolean
  /** `write-queue`: how far a split DECSET may be carried before the scan gives up. */
  PRIVATE_MODE_SCAN_TAIL_LIMIT: number
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
  /** `selection-state-and-eviction`: what counts as one word for select-all and word seeding. */
  WORD_RE: RegExp
  /** `selection-state-and-eviction`: how close to an edge a handle drag starts scrolling. */
  EDGE_SCROLL_PX: number
  /** `selection-state-and-eviction`: the edge-scroll tick, in milliseconds. */
  EDGE_SCROLL_INTERVAL: number
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
  /** `selection-overlay`: the press duration that starts a selection, in milliseconds. */
  LONG_PRESS_MS: number
  /** `selection-overlay`: the travel that cancels a pending long press, in pixels. */
  LONG_PRESS_SLOP: number
  /** `selection-overlay`: the travel that disqualifies a tap, in pixels. */
  TAP_SLOP: number
  /** `selection-overlay`: the longest press still counted as a tap, in milliseconds. */
  TAP_MAX_MS: number
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

/**
 * The six host seams, kept out of the state above because they are the one thing a reset must
 * not touch: the page sets them once per mount, before the start sequence runs.
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
  /** `terminal-theme`: paints the terminal's background behind the grid. */
  paintDocumentBackground: (background: string) => void
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
const textScalePresets = terminalTextScalePresets
const statusDot = String.fromCharCode(0x23fa)
const textPresentationSelector = String.fromCharCode(0xfe0e)
const emojiPresentationSelector = String.fromCharCode(0xfe0f)

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
    defaultTheme: terminalDefaultTheme,
    terminalTheme: terminalDefaultTheme,
    terminalMinimumContrastRatio: 3,
    initialOscLinks: [],
    initialOscLinkRowOffset: 0,
    ESC: String.fromCharCode(27),
    lastEmittedModes: {
      bracketedPasteMode: false,
      altScreen: false,
      mouseTrackingMode: 'none',
      sgrMouseMode: false,
      sgrMousePixelsMode: false
    },
    everReady: false,
    C1_CSI: String.fromCharCode(155),
    mouseModeScanTail: '',
    trackedMouseTrackingMode: 'none',
    sgrMouseMode: false,
    sgrMousePixelsMode: false,
    scrollIndicatorHideTimer: null,
    MIN_FIT_COLS: 20,
    MIN_TEXT_SCALE: textScalePresets[0],
    MAX_TEXT_SCALE: textScalePresets[textScalePresets.length - 1],
    handledMessageIds: [],
    currentTextScale: 1,
    terminalFontFamily: '',
    firstDataPending: false,
    activeAltScreenSnapshot: false,
    currentScale: 1,
    userScale: 1,
    CLAUDE_STATUS_DOT: statusDot,
    TEXT_PRESENTATION_SELECTOR: textPresentationSelector,
    EMOJI_PRESENTATION_SELECTOR: emojiPresentationSelector,
    CLAUDE_STATUS_DOT_PATTERN: new RegExp(
      statusDot + '[' + textPresentationSelector + emojiPresentationSelector + ']*',
      'g'
    ),
    statusDotPendingSelector: false,
    PRIVATE_MODE_SCAN_TAIL_LIMIT: 4096,
    writeQueue: [],
    writeQueueHead: 0,
    writesDraining: false,
    afterDrainCallbacks: [],
    ready: false,
    smoothScrollOffsetY: 0,
    pendingNormalScrollDeltaY: 0,
    normalScrollFrameId: null,
    WORD_RE: /[\p{L}\p{N}_./:@~+=?&#%-]/u,
    EDGE_SCROLL_PX: 40,
    EDGE_SCROLL_INTERVAL: 60,
    selMenu: null,
    btnCopy: null,
    btnSelAll: null,
    edgeScrollTimer: null,
    edgeScrollDir: 0,
    edgeScrollClientX: 0,
    edgeScrollClientY: 0,
    initialOscLinkEvictionReady: false,
    LONG_PRESS_MS: 500,
    LONG_PRESS_SLOP: 10,
    TAP_SLOP: 24,
    TAP_MAX_MS: 700,
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
    paintDocumentBackground: paintWindowDocumentBackground
  }
}

export function createTerminalDocumentScope(): TerminalDocumentScope {
  return { ...createTerminalDocumentState(), ...createTerminalDocumentHostSeams() }
}

/**
 * The scope back at the state a freshly parsed document has (ruling 21).
 *
 * The page mounts these modules more than once and an ES module body runs once per page, so this
 * is what makes a second mount a second document: the start sequence calls it first, and on the
 * WebView it runs once at parse, where it changes nothing. The seams are left alone — the page
 * sets them before the sequence runs, and they belong to the host rather than to the terminal.
 *
 * Two counters carry forward instead of resetting, because they are what a stale callback is
 * tested against: a frame scheduled by the mount that just went away compares its captured number
 * with the one here, and a reset to zero would make the old number match again.
 */
export function resetTerminalDocumentScope() {
  const generations = {
    terminalGeneration: scope.terminalGeneration + 1,
    fitRetryToken: scope.fitRetryToken + 1
  }
  Object.assign(scope, createTerminalDocumentState(), generations)
}

/** The document's own scope. The generator emits this declaration at the top of the script. */
export const scope: TerminalDocumentScope = createTerminalDocumentScope()

/**
 * An animation frame the document can take back (ruling 21).
 *
 * A generation guard makes a stale frame *do* nothing; it still runs, and inside a WebView that
 * is the same thing. On the page it is not: the mount that scheduled the frame may be gone and
 * the next one already up, and a callback that reads the scope reads the new mount's. Every frame
 * the document asks for is registered here so `cancelDocumentFrames` can take the pending ones
 * back, which is what the page's dispose does. The id is dropped as the frame runs, so the list
 * holds only what is still owed.
 */
export function scheduleDocumentFrame(callback: FrameRequestCallback) {
  // A stopped document asks for nothing. Tearing the terminal down runs the engine's own
  // disposal, which calls back into these modules, and a frame asked for on the way out would be
  // owed by nobody — the cancel has already run. `-1` is not a live frame id, so a caller that
  // holds one and cancels it later is cancelling nothing.
  if (scope.framesStopped) {
    return -1
  }
  const id = requestAnimationFrame(function (time) {
    const at = scope.scheduledFrames.indexOf(id)
    if (at !== -1) {
      scope.scheduledFrames.splice(at, 1)
    }
    callback(time)
  })
  scope.scheduledFrames.push(id)
  return id
}

/** Takes back every frame the document is still owed, and stops it asking for more. */
export function cancelDocumentFrames() {
  scope.framesStopped = true
  for (const id of scope.scheduledFrames) {
    cancelAnimationFrame(id)
  }
  scope.scheduledFrames = []
}
