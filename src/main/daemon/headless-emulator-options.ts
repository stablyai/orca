import type { TerminalEastAsianAmbiguousWidth } from '../../shared/east-asian-ambiguous-width'

export type HeadlessEmulatorOptions = {
  cols: number
  rows: number
  scrollback?: number
  /** Query reply sink (terminal-query-authority.md); only `forwardQueryReplies` writes emit here. The daemon Session must never pass this. */
  onQueryReply?: (reply: string) => void
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
  wslDistro?: string
  /** Match renderer EAW mode so headless mirrors do not tear under SSH (#9958). */
  eastAsianAmbiguousWidth?: TerminalEastAsianAmbiguousWidth
}

export type HeadlessEmulatorWriteOptions = {
  /** Reply ownership for this exact chunk; default false so seed/hydration/snapshot writes never forward (main-side replay guard; twin of renderer replay-guard.ts). */
  forwardQueryReplies?: boolean
}
