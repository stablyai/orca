import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'
import type { TerminalOscLinkRange } from '../../../src/shared/terminal-osc-link-ranges'

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
      // Width-reflow replay contains the same rewrapped content; preserve reader position instead of jumping to bottom.
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
