import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import { isRemoteRuntimePtyId } from '../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeTerminalSplit } from '../../shared/runtime-terminal-contracts'
import {
  getConnectionExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { readWorkspaceRecord, writeWorkspaceRecord } from './sidebar-inputs/sort-stamp-records'
import { createKeyedTrailingEdgeCoalescer } from './keyed-trailing-edge-coalescer'
import {
  isWslMoveProjectBlocked,
  wslMoveProjectRefForWorkspace
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

type Runtime = OrcaRuntimeWithMigrationCatalog

/** A window stamps Recent when a terminal starts or exits; with no window attached the host does,
 *  so a headless server's phones still sort by it. */
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
    // A reattach, or a start that opening the workspace caused, is no new work there.
    if (!created.isReattach && !args[1]?.opensWorkspace) {
      this.stampWindowlessTerminalActivity(created.worktreeId, created.executionHostId)
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

  override onPtyExit(...args: Parameters<Runtime['onPtyExit']>): ReturnType<Runtime['onPtyExit']> {
    const [ptyId, exitCode, exitIncarnationId, options = {}] = args
    // Read first: the exit clears the stop request and may prune the record.
    const pty = isRemoteRuntimePtyId(ptyId) ? undefined : this.ptysById.get(ptyId)
    // The base ignores an exit of any incarnation but the one registering or registered.
    const currentIncarnationId =
      this.pendingPtyRegistrationIncarnations.get(ptyId)?.incarnationId ?? pty?.incarnationId
    const endedOnItsOwn =
      !(exitIncarnationId && currentIncarnationId && exitIncarnationId !== currentIncarnationId) &&
      // A close, kill, sleep or restart is the user's or Orca's own stop, as the window skips it.
      !this.isPtyStopRequested(ptyId) &&
      !this.intentionalPtyStops.endsIntentionalStop(
        ptyId,
        exitIncarnationId ?? pty?.incarnationId
      ) &&
      // A lost host or dropped connection reports exits that are no work in the workspace.
      options.hostLost !== true &&
      (exitCode >= 0 || options.hostExitConfirmed === true || options.providerExitObserved === true)
    const result = super.onPtyExit(...args)
    if (pty && endedOnItsOwn) {
      this.stampWindowlessTerminalActivity(
        pty.worktreeId,
        getConnectionExecutionHostId(pty.connectionId)
      )
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

  private stampSplit(split: RuntimeTerminalSplit): RuntimeTerminalSplit {
    const pty = this.getLivePtyForHandle(split.handle)?.pty
    if (pty) {
      this.stampWindowlessTerminalActivity(
        pty.worktreeId,
        getConnectionExecutionHostId(pty.connectionId)
      )
    }
    return split
  }

  private stampWindowlessTerminalActivity(
    worktreeId: string,
    hostId: ExecutionHostId | undefined
  ): void {
    // Switch point: main's sort stamps own Recent. A window (or one still attaching) stamps its own.
    if (ORCA_SIDEBAR_INPUTS_IS_MAIN || this.authoritativeWindowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      return
    }
    const sshHostId = parseExecutionHostId(hostId)?.kind === 'ssh' ? (hostId ?? null) : null
    const workspace = { worktreeId, sshHostId }
    // A WSL move freezes only this machine's projects.
    if (
      !sshHostId &&
      isWslMoveProjectBlocked(this.store ?? undefined, wslMoveProjectRefForWorkspace(worktreeId))
    ) {
      return
    }
    try {
      // Only a workspace with a record is stamped; writing would create one for a stale id.
      if (!readWorkspaceRecord<object>(this.store, workspace)) {
        return
      }
      writeWorkspaceRecord(this.store, workspace, { lastActivityAt: Date.now() })
      this.sortStampNotices.schedule(worktreeId)
    } catch (error) {
      // The terminal already started or ended; a failed stamp must not fail that.
      console.warn('[runtime] failed to record terminal activity:', error)
    }
  }
}
