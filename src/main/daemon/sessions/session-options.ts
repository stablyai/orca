import type { SubprocessHandle } from './session-subprocess-handle'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { PtyStartupIngressIntent } from '../../../shared/terminal/pty/ingress/pty-startup-ingress-intent'
import type { PtyOwnerBackend } from '../../../shared/terminal/pty/lifecycle/pty-owner-backend'
import type { WslGuestRoot } from '../../../shared/wsl-guest-root-marker'
import type { TerminalSessionJournal } from '../history/journal/terminal-session-journal'

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
  historyJournal?: TerminalSessionJournal
  scrollback?: number
  wslDistro?: string
  /** Called once if the WSL bootstrap names its guest root shell in the launch output. */
  onWslGuestRoot?: (root: WslGuestRoot) => void
  // Let the host reap exited sessions and their scrollback emulators.
  onExit?: (code: number) => void
  startupIngress?: PtyStartupIngressIntent
  ownerBackend?: PtyOwnerBackend
}
