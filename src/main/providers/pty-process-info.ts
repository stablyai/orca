import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export type PtyProcessInfo = {
  id: string
  incarnationId?: PtyIncarnationId
  cwd: string
  title: string
  /** Owning worktree when the provider can report it authoritatively. */
  worktreeId?: string
  /** Trusted ORCA_TERMINAL_HANDLE exported into this PTY, when known. */
  terminalHandle?: string
  /** Exact WSL owner reported by the PTY provider; null means native Windows. */
  wslDistro?: string | null
  agentSessionOwners?: AgentSessionOwnerBinding[]
}
