import type { TerminalLaidOutCellBox } from '../terminal-cell-box'
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
  windowStart,
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

export type * from './document-terminal-shape'
export type { TerminalDocumentHost, TerminalDocumentHostSeams } from './document-host-seams'
// Keep cross-module mutable state per document; module-private state stays local to its factory-emitted module.

export type TerminalDocumentState = {
  term: TerminalDocumentTerminal | null
  // Pan is measured in viewport pixels.
  panX: number
  panY: number
  terminalGeneration: number
  termObserverDisposables: TerminalDocumentDisposable[]
  initRows: number
  webglAddon: TerminalDocumentWebglAddon | null
  webglRecoveryTimer: ReturnType<typeof setTimeout> | null
  terminalThemeInput: TerminalDocumentThemeMessage
  // Carry sub-line wheel travel between events; touch scroll resets it.
  wheelAccumDeltaY: number
  defaultTheme: TerminalDocumentTheme
  terminalTheme: TerminalDocumentTheme
  terminalMinimumContrastRatio: number
  initialOscLinks: TerminalInitialOscLink[]
  initialOscLinkRowOffset: number
  lastEmittedModes: TerminalDocumentModes
  everReady: boolean
  // Encoding is proven by 1006/1016, RIS or live tracking enable, never guessed from replay.
  mouseEncodingKnown: boolean
  // Retain a chunk tail because DECSET can span writes.
  mouseModeScanTail: string
  trackedMouseTrackingMode: string
  sgrMouseMode: boolean
  sgrMousePixelsMode: boolean
  scrollIndicatorHideTimer: ReturnType<typeof setTimeout> | null
  handledMessageIds: number[]
  currentTextScale: number
  terminalFontFamily: string
  firstDataPending: boolean
  reportedCellBox: TerminalLaidOutCellBox | null
  activeAltScreenSnapshot: boolean
  currentScale: number
  userScale: number
  // Remember incomplete selectors across queued chunks.
  statusDotPendingSelector: boolean
  writeQueue: TerminalWriteQueueEntry[]
  writeQueueHead: number
  writesDraining: boolean
  afterDrainCallbacks: (() => void)[]
  ready: boolean
  smoothScrollOffsetY: number
  pendingNormalScrollDeltaY: number
  normalScrollFrameId: number | null
  selMenu: HTMLElement | null
  btnCopy: HTMLElement | null
  btnSelAll: HTMLElement | null
  edgeScrollTimer: ReturnType<typeof setInterval> | null
  edgeScrollDir: number
  edgeScrollClientX: number
  edgeScrollClientY: number
  initialOscLinkEvictionReady: boolean
  selectionOverlay: HTMLElement | null
  handleStart: HTMLElement | null
  handleEnd: HTMLElement | null
  selMode: string
  sel: TerminalDocumentSelection | null
  longPressTimer: ReturnType<typeof setTimeout> | null
  longPressOrigin: TerminalDocumentTouchOrigin | null
  tapCandidate: TerminalDocumentTapCandidate | null
  bottomRowBackdrop: string
  surface: HTMLElement | null
  pendingTerm: TerminalDocumentTerminal | null
  committedTerm: TerminalDocumentTerminal | null
  provisionalTerm: TerminalDocumentTerminal | null
  committedSurface: HTMLElement | null
  pendingSurface: HTMLElement | null
  scrollIndicator: HTMLElement | null
  scrollThumb: HTMLElement | null
  terminalDataRepliesEnabled: boolean
  linesEverWritten: number
  nonFatalErrorNotifies: number
  uninstallErrorReporter: (() => void) | null
  uninstallHostTransport: (() => void) | null
  cancelFontReadiness: (() => void) | null
  removeViewportRefit: (() => void) | null
  removeTapDispatch: (() => void) | null
  removeWebglRecovery: (() => void) | null
  fitRetryToken: number
  hostFrame: { width: number; height: number } | null
  fitPending: string | null
  mouseGesture: TerminalMouseGesture | null
  touchDispatch: TerminalTouchDispatch
  touchGesture: TerminalTouchState
  scheduledFrames: number[]
  framesStopped: boolean
}

export type TerminalDocumentScope = TerminalDocumentState & TerminalDocumentHostSeams

export type TerminalDocumentSelection = {
  anchor: { row: number; col: number }
  focus: { row: number; col: number }
  activeHandle: string | null
}

export type TerminalDocumentTouchOrigin = { x: number; y: number; identifier: number }

export type TerminalDocumentTapCandidate = TerminalDocumentTouchOrigin & { t: number }

export type TerminalDocumentModes = {
  bracketedPasteMode: boolean
  altScreen: boolean
  mouseTrackingMode: string
  sgrMouseMode: boolean
  sgrMousePixelsMode: boolean
}

export type TerminalWriteQueueEntry = string | (() => void) | undefined

// Each document needs fresh state so remounts cannot inherit prior terminal state.

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
    mouseEncodingKnown: false,
    mouseModeScanTail: '',
    trackedMouseTrackingMode: 'none',
    sgrMouseMode: false,
    sgrMousePixelsMode: false,
    scrollIndicatorHideTimer: null,
    handledMessageIds: [],
    currentTextScale: 1,
    terminalFontFamily: '',
    firstDataPending: false,
    reportedCellBox: null,
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
    bottomRowBackdrop: '',
    surface: null,
    pendingTerm: null,
    committedTerm: null,
    provisionalTerm: null,
    committedSurface: null,
    pendingSurface: null,
    scrollIndicator: null,
    scrollThumb: null,
    terminalDataRepliesEnabled: false,
    linesEverWritten: 0,
    nonFatalErrorNotifies: 0,
    uninstallErrorReporter: null,
    uninstallHostTransport: null,
    cancelFontReadiness: null,
    removeViewportRefit: null,
    removeTapDispatch: null,
    removeWebglRecovery: null,
    fitRetryToken: 0,
    hostFrame: null,
    fitPending: null,
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
    start: windowStart,
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
