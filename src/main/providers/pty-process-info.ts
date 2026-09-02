import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { ForegroundProcessEvidence } from '../../shared/foreground-process-evidence'

export type PtyProcessInfo = {
  id: string
  incarnationId?: PtyIncarnationId
  /** Root process owned by this exact PTY incarnation, when the provider can prove it. */
  rootProcessId?: number
  cwd: string
  title: string
  /** Owning worktree when the provider can report it authoritatively. */
  worktreeId?: string
  /** Trusted ORCA_TERMINAL_HANDLE exported into this PTY, when known. */
  terminalHandle?: string
  /** Exact WSL owner reported by the PTY provider; null means native Windows. */
  wslDistro?: string | null
  /** Optional host-side process evidence attached to an inventory seed. */
  foregroundProcessEvidence?: ForegroundProcessEvidence
  agentSessionOwners?: AgentSessionOwnerBinding[]
}
