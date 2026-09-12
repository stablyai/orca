import type { SubprocessHandle } from './session-subprocess-handle'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type { PtyOwnerBackend } from '../../shared/pty-owner-backend'

export type SessionOptions = {
  sessionId: string
  cols: number
  rows: number
  terminalHandle?: string
  launchAgent?: TuiAgent
  subprocess: SubprocessHandle
  shellReadySupported: boolean
  shellReadyTimeoutMs?: number
  /** Reports a readiness outcome worth diagnosing to the daemon's file log.
   *  Why not console: the detached daemon runs with stdio 'ignore'. */
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
  historySeedChunks?: readonly string[]
  scrollback?: number
  wslDistro?: string
  // Fired once the session reaches a terminal state so the owner (TerminalHost) can reap it; without
  // a reaper, dead sessions and their scrollback emulators accumulate for the daemon's lifetime.
  onExit?: (code: number) => void
  startupIngress?: PtyStartupIngressIntent
  ownerBackend?: PtyOwnerBackend
}
