// SANDBOX-CONTROL-TYPECHECK: desktop shared settings types reach `import type { ITheme } from '@xterm/xterm'`, and
// xterm's typings pull in `/// <reference lib="dom" />`. DOM's Headers, streams and crypto then clash with
// @cloudflare/workers-types across this Worker. tsconfig `paths` maps the import here: the theme shape only (copied
// from @xterm/xterm's ITheme), no DOM.
export interface ITheme {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  selectionInactiveBackground?: string
  scrollbarSliderBackground?: string
  scrollbarSliderHoverBackground?: string
  scrollbarSliderActiveBackground?: string
  overviewRulerBorder?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
  extendedAnsi?: string[]
}
