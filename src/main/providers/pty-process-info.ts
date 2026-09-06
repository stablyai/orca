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
  /** Age measured on the OWNING host's clock. Absent means the host did not measure it, which is
   *  not the same as "new" or "old" — a reader that needs an age must defer instead of assuming. */
  hostAgeMs?: number
  /** True when the host spawned this PTY for an Orca pane, false for a bare host shell. Absent from
   *  a host that never published it; absence is neither value. */
  paneBound?: boolean
  /** The client identity the OWNING host recorded as having asked it to create this PTY. Absent
   *  whenever the host could not attest one, and absence must never be read as "unowned". */
  ownerClientInstanceId?: string
}
