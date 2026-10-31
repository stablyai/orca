export type TerminalModes = {
  bracketedPaste: boolean
  mouseTracking: boolean
  mouseTrackingMode?: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  sgrMouseMode?: boolean
  sgrMousePixelsMode?: boolean
  applicationCursor: boolean
  alternateScreen: boolean
  /** Kitty flags are restored separately after snapshot screen switches. */
  kittyKeyboardFlags?: number
  /** XTMODKEYS level; absent until first set, including an explicit disable. */
  modifyOtherKeys?: number
}
