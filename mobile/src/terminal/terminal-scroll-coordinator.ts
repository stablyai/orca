export type TerminalScrollMetrics = {
  baseY: number
  viewportY: number
  bufferMode: 'normal' | 'alternate'
}

export type TerminalViewportChange = {
  cols: number
  rows: number
  reason: 'font' | 'window' | 'reflow' | 'resize'
}

export type TerminalScrollAdapter = {
  readMetrics: () => TerminalScrollMetrics | null
  scrollLines: (lines: number) => void
  scrollToBottom: () => void
  scrollToLine: (line: number) => void
  changeViewport: (change: TerminalViewportChange) => void
  routeTerminalInput: (lines: number, clientX?: number, clientY?: number) => void
  shouldRouteToTerminalInput: () => boolean
  revealIndicator: () => void
}

export type TerminalScrollEvent =
  | { type: 'begin-generation'; generation: number; preserveScroll: boolean }
  | { type: 'replay-committed'; generation: number }
  | { type: 'output-started'; generation: number }
  | { type: 'output-committed'; generation: number }
  | { type: 'user-scroll-lines'; generation: number; lines: number }
  | {
      type: 'user-scroll-pixels'
      generation: number
      deltaY: number
      pixelsPerLine: number
      clientX?: number
      clientY?: number
    }
  | { type: 'reset-gesture'; generation: number }
  | { type: 'jump-to-bottom'; generation: number }
  | { type: 'viewport-change'; generation: number; change: TerminalViewportChange }
  | { type: 'viewport-committed'; generation: number }

export type TerminalScrollState = {
  generation: number
  intent: 'following-output' | 'reading-history'
  distanceFromBottom: number
}
