import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { isRemoteRuntimePtyId } from '../../shared/remote-runtime/remote-runtime-pty-id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { agentPaneWorkspace } from '../agent-hooks/agent-transition-detector'
import { readWorkspaceRecord, writeWorkspaceRecord } from './sidebar-inputs/sort-stamp-records'
import {
  isWslMoveProjectBlocked,
  wslMoveProjectRefForWorkspace
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

type Runtime = OrcaRuntimeWithMigrationCatalog

/** Without a window, the host stamps Recent on the terminal starts and exits the window's store would have. */
export abstract class OrcaRuntimeWithHeadlessWorkspaceActivity extends OrcaRuntimeWithMigrationCatalog {
  override async createTerminal(
    ...args: Parameters<Runtime['createTerminal']>
  ): ReturnType<Runtime['createTerminal']> {
    const created = await super.createTerminal(...args)
    // A reattached or cold-restored pane is the workspace reopening, not new work in it.
    if (!created.isReattach && !created.coldRestore && created.ptyId) {
      this.recordHeadlessTerminalActivity(created.ptyId)
    }
    return created
  }

  override async splitTerminal(
    ...args: Parameters<Runtime['splitTerminal']>
  ): ReturnType<Runtime['splitTerminal']> {
    const split = await super.splitTerminal(...args)
    const ptyId = this.isHeadlessActivityOwner()
      ? this.getLivePtyForHandle(split.handle)?.pty.ptyId
      : undefined
    if (ptyId) {
      this.recordHeadlessTerminalActivity(ptyId)
    }
    return split
  }

  override onPtyExit(...args: Parameters<Runtime['onPtyExit']>): ReturnType<Runtime['onPtyExit']> {
    const [ptyId] = args
    // Read first: the exit clears the stop request, disconnects and may prune the record. A requested stop is a close or sleep.
    const record = this.ptysById.get(ptyId)
    const endsLiveWork = record?.connected === true && !this.isPtyStopRequested(ptyId)
    const result = super.onPtyExit(...args)
    if (endsLiveWork && !this.isWorktreeTerminalSleepHeld(record.worktreeId)) {
      this.recordHeadlessTerminalActivity(ptyId, record)
    }
    return result
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

  // Switch point: main's sort stamps own Recent then; a window's store stamps it otherwise.
  private isHeadlessActivityOwner(): boolean {
    return !ORCA_SIDEBAR_INPUTS_IS_MAIN && this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID
  }

  private recordHeadlessTerminalActivity(ptyId: string, record = this.ptysById.get(ptyId)): void {
    if (!this.isHeadlessActivityOwner()) {
      return
    }
    // A paired server's terminal is that server's to record.
    if (!record?.worktreeId || isRemoteRuntimePtyId(ptyId)) {
      return
    }
    const workspace = agentPaneWorkspace(record.worktreeId, record.connectionId)
    if (
      !workspace.sshHostId &&
      isWslMoveProjectBlocked(
        this.store ?? undefined,
        wslMoveProjectRefForWorkspace(workspace.worktreeId)
      )
    ) {
      return
    }
    // Only a workspace with a record is stamped; writing would create one for a stale id.
    if (!readWorkspaceRecord<unknown>(this.store, workspace)) {
      return
    }
    writeWorkspaceRecord(this.store, workspace, { lastActivityAt: Date.now() })
    this.notifySortStampsChanged(workspace.worktreeId)
  }
}
