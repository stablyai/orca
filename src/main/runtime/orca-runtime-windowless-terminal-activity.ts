import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import { isRemoteRuntimePtyId } from '../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeTerminalSplit } from '../../shared/runtime-terminal-contracts'
import { parseExecutionHostId } from '../../shared/execution-host'
import { isRestoreSpawnIntent } from '../../shared/host-spawn-admission'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { readWorkspaceRecord, writeWorkspaceRecord } from './sidebar-inputs/sort-stamp-records'
import { createKeyedTrailingEdgeCoalescer } from './keyed-trailing-edge-coalescer'
import {
  agentPaneWorkspace,
  type AgentPaneWorkspace
} from '../agent-hooks/agent-transition-detector'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  isWslMoveProjectBlocked,
  wslMoveProjectRefForWorkspace
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

type Runtime = OrcaRuntimeWithMigrationCatalog

/** A window stamps Recent when a terminal starts or exits; on a headless host main does, so its
 *  phones still sort by it. */
export abstract class OrcaRuntimeWithWindowlessTerminalActivity extends OrcaRuntimeWithMigrationCatalog {
  // Coalesce bursts (a fleet's terminal starts, streaming titles) into one re-list notice; store writes already landed.
  protected readonly sortStampNotices = createKeyedTrailingEdgeCoalescer(
    (worktreeId) => this.notifySortStampsChanged(worktreeId),
    { flushMs: 50, maxWaitMs: 250 }
  )

  override async createTerminal(
    ...args: Parameters<Runtime['createTerminal']>
  ): ReturnType<Runtime['createTerminal']> {
    const created = await super.createTerminal(...args)
    const opts = args[1]
    // A reattach, a saved session's resume, or a pane started again is no new work in the workspace.
    if (
      this.stampsTerminalActivity() &&
      !created.isReattach &&
      !isRestoreSpawnIntent(opts?.spawnIntent) &&
      !opts?.reopensPane
    ) {
      const hostId = created.executionHostId
      this.stampTerminalActivity({
        worktreeId: created.worktreeId,
        sshHostId: parseExecutionHostId(hostId)?.kind === 'ssh' ? (hostId ?? null) : null
      })
    }
    return created
  }

  override async splitTerminal(
    ...args: Parameters<Runtime['splitTerminal']>
  ): ReturnType<Runtime['splitTerminal']> {
    return this.stampSplit(await super.splitTerminal(...args))
  }

  override async splitTerminalPane(
    ...args: Parameters<Runtime['splitTerminalPane']>
  ): ReturnType<Runtime['splitTerminalPane']> {
    return this.stampSplit(await super.splitTerminalPane(...args))
  }

  protected override notePtyEndedOnItsOwn(pty: RuntimePtyWorktreeRecord): void {
    super.notePtyEndedOnItsOwn(pty)
    // A paired server's terminal is that server's to record.
    if (this.stampsTerminalActivity() && !isRemoteRuntimePtyId(pty.ptyId)) {
      this.stampTerminalActivity(agentPaneWorkspace(pty.worktreeId, pty.connectionId))
    }
  }

  // Metadata only: clients re-list the record, and the cached git scans stay.
  protected notifySortStampsChanged(worktreeId: string): void {
    if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
      this.notifyFolderWorkspaceChanged()
      return
    }
    this.invalidateResolvedWorktreeCache()
    this.notifyWorktreesChanged(getRepoIdFromWorktreeId(worktreeId), { invalidateGitScans: false })
  }

  // Switch point: main's sort stamps own Recent. Only a headless host (serve, orcad) stamps here: a
  // window stamps its own, and a desktop between windows (null) stays unstamped, as before.
  private stampsTerminalActivity(): boolean {
    return !ORCA_SIDEBAR_INPUTS_IS_MAIN && this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID
  }

  private stampSplit(split: RuntimeTerminalSplit): RuntimeTerminalSplit {
    const pty = this.stampsTerminalActivity() ? this.getLivePtyForHandle(split.handle)?.pty : null
    if (pty) {
      this.stampTerminalActivity(agentPaneWorkspace(pty.worktreeId, pty.connectionId))
    }
    return split
  }

  private stampTerminalActivity(workspace: AgentPaneWorkspace): void {
    // A WSL move freezes only this machine's projects.
    if (
      !workspace.sshHostId &&
      isWslMoveProjectBlocked(
        this.store ?? undefined,
        wslMoveProjectRefForWorkspace(workspace.worktreeId)
      )
    ) {
      return
    }
    try {
      // Only a workspace with a record is stamped; writing would create one for a stale id.
      if (!readWorkspaceRecord<object>(this.store, workspace)) {
        return
      }
      writeWorkspaceRecord(this.store, workspace, { lastActivityAt: Date.now() })
      this.sortStampNotices.schedule(workspace.worktreeId)
    } catch (error) {
      // The terminal already started or ended; a failed stamp must not fail that.
      console.warn('[runtime] failed to record terminal activity:', error)
    }
  }
}
