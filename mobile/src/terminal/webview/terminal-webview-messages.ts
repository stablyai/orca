import type { TerminalFontStyle } from '../preferences/terminal-font-style'
import type { RuntimeMobileTerminalTheme } from '../../../../src/shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { TerminalOscLinkRange } from '../../../../src/shared/terminal/links/terminal-osc-link-ranges'

export type TerminalFrame = { width: number; height: number }

// Desktop terminal settings the phone follows; scrollback is capped for phone memory.
export type TerminalHostSettings = { scrollbackRows: number; wordSeparator: string }

// The app's own colours for chrome drawn inside the terminal (the selection menu and handles).
export type TerminalChromeColors = {
  surface: string
  text: string
  line: string
  pressed: string
  accent: string
}

export type TerminalWebViewCommand =
  | { type: 'set-interaction-active'; active: boolean }
  | { type: 'ping'; id?: number }
  // `onParsed` survives only an in-process post; a native bridge drops it.
  | { type: 'write'; id?: number; data: string; onParsed?: () => void }
  | ({
      type: 'init'
      id?: number
      cols: number
      rows: number
      initialData?: string
      oscLinks?: TerminalOscLinkRange[]
      kittyKeyboardFlags?: number
      terminalTheme?: RuntimeMobileTerminalTheme
      fontScale?: number
      fontStyle?: TerminalFontStyle
      // Width-reflow replay contains the same rewrapped content; preserve reader position instead of jumping to bottom.
      preserveScroll?: boolean
      frame: TerminalFrame | null
    } & Partial<TerminalHostSettings>)
  | { type: 'set-font-scale'; id?: number; fontScale: number }
  | { type: 'set-font-style'; id?: number; fontStyle: TerminalFontStyle; fontFaceCss?: string }
  | { type: 'resize'; id?: number; cols: number; rows: number; frame: TerminalFrame | null }
  | { type: 'reflow'; id?: number; cols: number; rows: number; frame: TerminalFrame | null }
  | { type: 'clear'; id?: number }
  | { type: 'scroll-to-bottom'; id?: number }
  | { type: 'reset-zoom'; id?: number }
  | { type: 'cancel-select'; id?: number }
  | { type: 'do-select-all'; id?: number }
  | { type: 'set-theme'; id?: number; terminalTheme?: RuntimeMobileTerminalTheme }
  | { type: 'set-chrome'; id?: number; chrome: TerminalChromeColors }
  | ({ type: 'set-host-settings'; id?: number } & TerminalHostSettings)
