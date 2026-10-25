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
  /** Use the daemon file log: detached stdio is ignored. */
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
  historySeedChunks?: readonly string[]
  scrollback?: number
  wslDistro?: string
  // Let the host reap exited sessions and their scrollback emulators.
  onExit?: (code: number) => void
  startupIngress?: PtyStartupIngressIntent
  ownerBackend?: PtyOwnerBackend
}
