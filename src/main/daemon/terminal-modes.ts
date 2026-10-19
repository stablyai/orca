export type TerminalModes = {
  bracketedPaste: boolean
  mouseTracking: boolean
  mouseTrackingMode?: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  sgrMouseMode?: boolean
  sgrMousePixelsMode?: boolean
  applicationCursor: boolean
  alternateScreen: boolean
  /** Kitty keyboard protocol flags used only to reseed a warm daemon emulator. */
  kittyKeyboardFlags?: number
  /** xterm modifyOtherKeys level (CSI > 4 ; n m); absent until the app first arms it. */
  modifyOtherKeys?: number
}
