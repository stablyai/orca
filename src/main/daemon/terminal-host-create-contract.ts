import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import type { ShellReadyState, TerminalSnapshot } from './types'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

export type CreateOrAttachOptions = {
  sessionId: string
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
}

export type CreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
  launchAgent?: TuiAgent
  wslDistro: string | null
  attachToken: symbol
  incarnationId: PtyIncarnationId
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  /** Fresh non-WSL spawns with an explicit cwd only; false means a proven permission denial. */
  cwdReadableByDaemon?: boolean
  /** The live child can no longer take input through its PTY master. */
  inputClosed?: true
}
