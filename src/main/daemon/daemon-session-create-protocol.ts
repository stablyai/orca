import type { AgentResumeCommand } from '../../shared/agent-resume-command'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type * as HistorySeedProtocol from './terminal-history-seed-transfer-protocol'

export type CreateOrAttachRequest = {
  id: string
  type: 'createOrAttach'
  payload: HistorySeedProtocol.CreateOrAttachHistorySeedPayload & {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    agentResume?: AgentResumeCommand
    startupCommandDelivery?: StartupCommandDelivery
    launchAgent?: TuiAgent
    /** Rejects an absent session instead of interpreting mount uncertainty as create permission. */
    attachOnly?: boolean
    /** Explicit Windows shell override selected by the user (e.g. 'wsl.exe').
     *  The daemon forwards this to its subprocess spawner so each tab honors
     *  the shell picked in the "+" menu or the persisted default-shell setting,
     *  instead of defaulting to COMSPEC (which is always cmd.exe on Windows)
     *  or the hard-coded powershell.exe fallback. */
    shellOverride?: string
    /** Preferred WSL distro for generic `wsl.exe` launches. */
    terminalWindowsWslDistro?: string | null
    /** Why: the UI keeps PowerShell as one shell family, but the runtime may
     *  need to substitute pwsh.exe for powershell.exe when the user selected
     *  PowerShell 7+. Forward the persisted implementation choice so the daemon
     *  PTY path resolves the same effective executable as LocalPtyProvider. */
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
    shellReadySupported?: boolean
    shellReadyTimeoutMs?: number
    /** Server-side fence that prevents a client timeout from publishing an orphan PTY. */
    cancelAfterMs?: number
    startupIngress?: PtyStartupIngressIntent
    agentSessionEnsure?: {
      claim: AgentSessionExecutionClaim
      surface: AgentSessionSurfaceBinding
    }
  }
}
