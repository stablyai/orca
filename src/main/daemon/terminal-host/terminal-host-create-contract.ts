import type { DaemonLaunchNote } from '../protocol/daemon-launch-note-protocol'
import type { StartupCommandDelivery } from '../../../shared/agent-launch/startup/codex-startup-delivery'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { ShellReadyState } from '../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../protocol/terminal-snapshot'
import type { PtyStartupIngressIntent } from '../../../shared/terminal/pty/ingress/pty-startup-ingress-intent'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../../shared/agent-session/agent-session-host-authority'
import type { PtyIncarnationId } from '../../../shared/terminal/pty/lifecycle/pty-incarnation'
import type { TerminalExitCause } from '../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import type { TerminalHistoryOutcome } from '../protocol/daemon-history-protocol'

/** Deep-history admission an attach takes before its atomic cut, while the old viewer stays. */
export type AttachHistoryAdmission = {
  admit(sessionId: string, incarnationId: string): Promise<AttachHistoryHold | null>
}

export type AttachHistoryHold = {
  /**
   * Synchronous with the live snapshot and token attach: freezes the cut, or substitutes the
   * image at a proved anchor and encodes the final reply. 'retry' leaves the old viewer intact.
   */
  capture(result: Omit<CreateOrAttachResult, 'attachToken'>): 'captured' | 'retry'
  release(): void
}

export type CreateOrAttachOptions = {
  sessionId: string
  attachHistory?: AttachHistoryAdmission
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  startupCommandDelivery?: StartupCommandDelivery
  launchAgent?: TuiAgent
  /** Missing ownership is not permission to create during stable-pane adoption. */
  attachOnly?: boolean
  shellOverride?: string
  terminalShellArgs?: string[]
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  shellReadySupported?: boolean
  shellReadyTimeoutMs?: number
  historySeedChunks?: readonly string[]
  startupIngress?: PtyStartupIngressIntent
  agentSessionEnsure?: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
  }
  streamClient: {
    onData: (data: string, rawLength?: number, transformed?: boolean, seq?: number) => void
    onExit: (code: number, incarnationId: PtyIncarnationId, cause?: TerminalExitCause) => void
    /** The child may still run, but its PTY master no longer takes input. */
    onInputClosed?: (incarnationId: PtyIncarnationId) => void
  }
  /** Resolve the adopted owner’s canonical ID before stream callbacks can emit output. */
  onSessionResolved?: (sessionId: string) => void
  /** The exact token just installed, in the same turn, before any await or output delivery. */
  onClientAttached?: (sessionId: string, token: symbol) => void
}

export type CreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
  launchAgent?: TuiAgent
  launchNote?: DaemonLaunchNote | null
  wslDistro: string | null
  attachToken: symbol
  incarnationId: PtyIncarnationId
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  /** Fresh non-WSL spawns with an explicit cwd only; false means a proven permission denial. */
  cwdReadableByDaemon?: boolean
  /** The live child can no longer take input through its PTY master. */
  inputClosed?: true
  history?: TerminalHistoryOutcome
}
