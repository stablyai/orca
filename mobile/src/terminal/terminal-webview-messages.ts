import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'

export type TerminalWebViewCommand =
  | { type: 'write'; id?: number; data: string }
  | {
      type: 'init'
      id?: number
      cols: number
      rows: number
      initialData?: string
      terminalTheme?: RuntimeMobileTerminalTheme
      fontScale?: number
    }
  | { type: 'set-font-scale'; id?: number; fontScale: number }
  | { type: 'resize'; id?: number; cols: number; rows: number }
  | { type: 'clear'; id?: number }
  | { type: 'measure'; id?: number; containerHeight?: number }
  | { type: 'reset-zoom'; id?: number }
  | { type: 'cancel-select'; id?: number }
  | { type: 'do-select-all'; id?: number }
  | { type: 'set-theme'; id?: number; terminalTheme?: RuntimeMobileTerminalTheme }
