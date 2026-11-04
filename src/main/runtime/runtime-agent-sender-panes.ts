import { isStructuredWorkerHandle } from '../../shared/structured-worker-handle'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeAgentOrchestrationDependencies } from './runtime-agent-orchestration-projection'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { AgentSenderPane } from './runtime-agent-sender-history'

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

type Dependencies = Pick<
  RuntimeAgentOrchestrationDependencies,
  'getLeaves' | 'getPtys' | 'paneOf' | 'makePaneKey'
> &
  AgentSenderHandleReads
const MAX_HANDLE_INCARNATIONS = 4096

export class AgentSenderLivePanes {
  private readonly handleIncarnations = new Map<string, string>()
  constructor(
    private readonly deps: Dependencies,
    private readonly work: { leafVisits: number; ptyVisits: number }
  ) {}
  read(): Map<string, AgentSenderPane & { original: boolean }> {
    const panes = new Map<string, AgentSenderPane & { original: boolean }>()
    const ptys = new Map([...this.deps.getPtys()].map((pty) => [pty.ptyId, pty]))
    const terminal = (
      handle: string | null,
      paneKey: string | null,
      worktreeId: string | null,
      ptyId: string | null
    ) => {
      if (
        !handle ||
        !paneKey ||
        !worktreeId ||
        isStructuredWorkerHandle(handle) ||
        !parsePaneKey(paneKey)
      ) {
        return
      }
      const pty = ptyId ? ptys.get(ptyId) : undefined
      const processIncarnation = pty?.incarnationId ? `${pty.ptyId}:${pty.incarnationId}` : null
      panes.set(paneKey, {
        paneKey,
        worktreeId,
        handle,
        processIncarnation,
        original: this.originalExecution(handle, processIncarnation)
      })
    }
    for (const leaf of this.deps.getLeaves()) {
      this.work.leafVisits++
      if (leaf.ptyId) {
        terminal(
          this.deps.readLeafHandle(leaf),
          this.deps.makePaneKey(leaf),
          leaf.worktreeId,
          leaf.ptyId
        )
      }
    }
    const readPtyHandle = this.deps.readPtyHandles()
    for (const pty of ptys.values()) {
      this.work.ptyVisits++
      const paneKey = this.deps.paneOf(pty).paneKey
      if (paneKey && !panes.has(paneKey)) {
        terminal(readPtyHandle(pty), paneKey, pty.worktreeId, pty.ptyId)
      }
    }
    return panes
  }

  /** A handle names the execution it was issued to; restart reattach keeps both, but a respawn
   *  that kept the handle runs a fresh shell, so its old cards no longer name what runs there. */
  private originalExecution(handle: string, incarnation: string | null): boolean {
    if (!incarnation) {
      return true
    }
    const first = this.handleIncarnations.get(handle)
    if (first === undefined) {
      this.handleIncarnations.set(handle, incarnation)
      if (this.handleIncarnations.size > MAX_HANDLE_INCARNATIONS) {
        const oldest = this.handleIncarnations.keys().next().value
        if (oldest !== undefined) {
          this.handleIncarnations.delete(oldest)
        }
      }
    }
    return first === undefined || first === incarnation
  }
}
