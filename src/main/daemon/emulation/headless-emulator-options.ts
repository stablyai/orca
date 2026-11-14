import type { ITerminalOptions } from '@xterm/headless'
import type { TerminalContentOrigin } from '../../../shared/terminal/output/terminal-content-origin'

/** windowsPty: ConPTY repaints its own grid after a resize, so growing rows must not pull scrollback. */
export type HeadlessEmulatorOptions = Pick<ITerminalOptions, 'windowsPty'> & {
  cols: number
  rows: number
  scrollback?: number
  /** Only opted-in live writes may reply; daemon Session must never supply this sink. */
  onQueryReply?: (reply: string) => void
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
  wslDistro?: string
}

export type HeadlessEmulatorWriteOptions = {
  contentOrigin?: TerminalContentOrigin
  /** Opt in only for live chunks; seed, hydration and snapshot writes must never reply. */
  forwardQueryReplies?: boolean
}
