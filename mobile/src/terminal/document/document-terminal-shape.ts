import type { IUnicodeHandling } from '@xterm/xterm'
import type { XtermUnicodeServiceCore } from '../../../../src/shared/terminal-unicode-provider'

// Describe only xterm members the document consumes; native globals and embedded imports satisfy the same seam.

export type TerminalOscLinkService = { getLinkData?: (id: number) => { uri?: string } | undefined }

export type TerminalDocumentCore = XtermUnicodeServiceCore & {
  _renderService?: { dimensions?: { css: { cell: { height: number; width: number } } } }
  _oscLinkService?: TerminalOscLinkService
  _inputHandler?: { _oscLinkService?: TerminalOscLinkService }
}

export type TerminalInitialOscLink = {
  uri?: string
  row: number
  startCol: number
  endCol: number
  text?: string
}

// xterm attribute getters return numbers, so consumers test truthiness rather than boolean equality.
export type TerminalDocumentCell = {
  getChars?: () => string
  getWidth?: () => number
  isBgDefault: () => boolean
  isBgRGB?: () => boolean
  getBgColor?: () => number
  extended?: { urlId?: number }
  isInverse: () => number
  isUnderline?: () => number
  isStrikethrough?: () => number
  isOverline?: () => number
}

export type TerminalDocumentLine = {
  readonly length: number
  readonly isWrapped: boolean
  translateToString: (trimRight: boolean, startColumn?: number, endColumn?: number) => string
  getCell?: (x: number, cell?: TerminalDocumentCell) => TerminalDocumentCell | undefined
}

export type TerminalDocumentBuffer = {
  readonly length: number
  readonly viewportY: number
  readonly baseY: number
  readonly cursorY: number
  readonly type: string
  getNullCell?: () => TerminalDocumentCell
  getLine: (index: number) => TerminalDocumentLine | undefined
}

export type TerminalDocumentTheme = Record<string, string>

export type TerminalDocumentTerminalOptions = {
  theme: TerminalDocumentTheme
  minimumContrastRatio: number
  fontSize: number
}

export type TerminalDocumentTerminal = {
  readonly cols: number
  readonly rows: number
  readonly buffer: { readonly active: TerminalDocumentBuffer }
  options: TerminalDocumentTerminalOptions
  write: (data: string, callback?: () => void) => void
  open: (element: HTMLElement) => void
  scrollToLine: (line: number) => void
  clear: () => void
  reset: () => void
  selectAll: () => void
  getSelection?: () => string
  select: (col: number, row: number, length: number) => void
  clearSelection: () => void
  readonly unicode: IUnicodeHandling
  attachCustomKeyEventHandler: (handler: () => boolean) => void
  onData: (listener: (data: string) => void) => TerminalDocumentDisposable
  readonly parser?: {
    registerOscHandler: (
      ident: number,
      callback: (data: string) => boolean
    ) => { dispose: () => void }
  }
  readonly textarea?: {
    readOnly: boolean
    tabIndex: number
    setAttribute: (name: string, value: string) => void
  }
  readonly element?: HTMLElement
  readonly _core?: TerminalDocumentCore
  readonly modes?: {
    bracketedPasteMode?: boolean
    mouseTrackingMode?: string
    applicationCursorKeysMode?: boolean
  }
  onLineFeed?: (listener: () => void) => TerminalDocumentDisposable
  onScroll?: (listener: () => void) => TerminalDocumentDisposable
  onWriteParsed?: (listener: () => void) => TerminalDocumentDisposable
  onRender?: (listener: () => void) => TerminalDocumentDisposable
  resize: (cols: number, rows: number) => void
  refresh: (start: number, end: number) => void
  dispose: () => void
  loadAddon: (addon: TerminalDocumentWebglAddon) => void
  scrollToBottom: () => void
  scrollLines: (amount: number) => void
}

export type TerminalDocumentDisposable = { dispose?: () => void }

export type TerminalDocumentWebglAddon = {
  onContextLoss?: (listener: () => void) => void
  clearTextureAtlas?: () => void
  dispose: () => void
}
