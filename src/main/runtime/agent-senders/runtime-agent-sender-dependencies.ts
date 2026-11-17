import type { RuntimeAgentOrchestrationDependencies } from '../orchestration/crew/runtime-agent-orchestration-projection'
import type { AgentSenderPrincipal } from './agent-sender-principals'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../terminal/records/runtime-terminal-state-records'

/** The handles terminals already hold, read without issuing one: display bookkeeping never
 *  changes terminal identity, so a terminal with no issued handle has no sender row. */
export type AgentSenderHandleReads = {
  hasPublishedScope?(worktreeId: string): boolean
  readLeafHandle(leaf: RuntimeLeafRecord): string | null
  /** One reader per walk, so a lookup that must index records does it once per build. */
  readPtyHandles(): (pty: RuntimePtyWorktreeRecord) => string | null
}

/** Orchestration issues terminal handles; sender rows only read the ones already issued. */
export type TerminalHandleAccess = Pick<
  RuntimeAgentOrchestrationDependencies,
  'issueLeafHandle' | 'issuePtyHandle'
> &
  AgentSenderHandleReads

export type Dependencies = Omit<
  RuntimeAgentOrchestrationDependencies,
  'issueLeafHandle' | 'issuePtyHandle'
> &
  AgentSenderHandleReads & {
    peerFingerprint(): string | undefined
    /** This host's principal as the paired environment authenticates it, and that peer's key. */
    principal(
      environmentId: string
    ): AgentSenderPrincipal | undefined | Promise<AgentSenderPrincipal | undefined>
    /** Moves when a pairing changes, so principals are read again only then. */
    pairingGeneration(): number
  }
