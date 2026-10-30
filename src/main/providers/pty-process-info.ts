import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { ForegroundProcessEvidence } from '../../shared/foreground-process-evidence'

export type PtyProcessInfo = {
  id: string
  incarnationId?: PtyIncarnationId
  /** Local diagnostic provenance supplied by a multi-daemon router. */
  inventorySourceId?: string
  /** Whether this diagnostic candidate is the established route for its id. */
  routed?: boolean
  /** Root process owned by this exact PTY incarnation, when the provider can prove it. */
  rootProcessId?: number
  /** Recently observed process name; inventory reads never initiate process inspection. */
  foregroundProcess?: string
  cwd: string
  title: string
  /** Owning worktree when the provider can report it authoritatively. */
  worktreeId?: string
  /** Trusted ORCA_TERMINAL_HANDLE exported into this PTY, when known. */
  terminalHandle?: string
  /** ORCA_PANE_KEY this PTY was spawned with, when the provider recorded it. */
  paneKey?: string
  /** Exact WSL owner reported by the PTY provider; null means native Windows. */
  wslDistro?: string | null
  /** Optional host-side process evidence attached to an inventory seed. */
  foregroundProcessEvidence?: ForegroundProcessEvidence
  agentSessionOwners?: AgentSessionOwnerBinding[]
  /** Owning-host clock age; absent is unmeasured, so age-dependent decisions must defer. */
  hostAgeMs?: number
  /** Host attests Orca pane (true) or bare shell (false); absent is unknown on older hosts. */
  paneBound?: boolean
  /** Creator identity attested by the owning host; absent never means unowned. */
  ownerClientInstanceId?: string
  /** Still live during accepted termination, but cannot be adopted/restored; absent on older hosts. */
  exiting?: true
}
