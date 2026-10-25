import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'
import type { TerminalOscLinkRange } from '../../../src/shared/terminal-osc-link-ranges'

/** The frame React Native laid out, sent with each grid so the document fits a text-size change to it. */
export type TerminalFrame = { width: number; height: number }

export type TerminalWebViewCommand =
  | { type: 'ping'; id?: number }
  | { type: 'write'; id?: number; data: string }
  | {
      type: 'init'
      id?: number
      cols: number
      rows: number
      initialData?: string
      oscLinks?: TerminalOscLinkRange[]
      terminalTheme?: RuntimeMobileTerminalTheme
      fontScale?: number
      // Why: width-reflow re-streams replay the same content rewrapped at new
      // cols; preserve the reader's scroll position instead of jumping to bottom.
      preserveScroll?: boolean
      frame: TerminalFrame | null
    }
  | { type: 'set-font-scale'; id?: number; fontScale: number }
  | { type: 'resize'; id?: number; cols: number; rows: number; frame: TerminalFrame | null }
  | { type: 'reflow'; id?: number; cols: number; rows: number; frame: TerminalFrame | null }
  | { type: 'clear'; id?: number }
  | { type: 'reset-zoom'; id?: number }
  | { type: 'cancel-select'; id?: number }
  | { type: 'do-select-all'; id?: number }
  | { type: 'set-theme'; id?: number; terminalTheme?: RuntimeMobileTerminalTheme }
