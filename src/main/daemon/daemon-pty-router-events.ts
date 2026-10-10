import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

export type DaemonPtyRouterDataEvent = {
  id: string
  data: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
}

export type DaemonPtyRouterExitEvent = {
  id: string
  code: number
  incarnationId?: PtyIncarnationId
  /** Absent from a daemon predating exit causes; readers fall back to `unknown`. */
  cause?: TerminalExitCause
}
