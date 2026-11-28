import { OrcaRuntimeWithResolveTerminalSplitSourceAuthority } from '../launch/terminal-split-source-authority'
import type { WorkspaceSessionPartitionId } from '../../../../shared/workspace-session/teammate-homes-session-partition'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import { teardownRpcDeadline } from '../../workspaces/removal/worktree-teardown-deadline'
import type {
  RuntimeWorktreeTerminalCloseResult,
  RuntimeWorktreeTerminalSleepResult
} from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { WorktreeTerminalStopOptions } from './worktree-terminal-stop-options'
import type { WorktreeTerminalMutationKind } from '../../workspaces/lifecycle/worktree-terminal-mutation-lock'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { cloneWorkspaceSessionState } from '../../../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../../persistence/restoring-sessions/workspace-session-write-rollback'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { WorktreePtyHostFence } from '../../workspaces/removal/worktree-pty-host-fence'
import { collectWorktreePtyIds } from './worktree-pty-collection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { withMainBoundLeaves } from '../surface/main-terminal-surfaces'
import { mainHoldsTerminal } from '../surface/main-pane-verdict'
import { summarizeWorktreePtyStopVerdict } from '../../workspaces/removal/worktree-pty-stop-verdict'
import {
  clearClosedWorktreeResumeRecords,
  clearWorkspaceTerminals
} from './worktree-sleep-resume-records'
import {
  anySleepKeyNames,
  listSleepWorkspaceId,
  resolveSleepScope
} from './worktree-terminal-sleep-key'
import type { WorktreeSleepScope } from './worktree-terminal-sleep-key'
import type { PtyList } from '../records/runtime-terminal-state-records'

export abstract class OrcaRuntimeWithStopTerminalsForWorktree extends OrcaRuntimeWithResolveTerminalSplitSourceAuthority {
  protected abstract sleepResolvedWorktreeTerminals(
    worktree: ResolvedWorktree,
    scope: WorktreeSleepScope,
    soleLivePtyId?: string
  ): Promise<RuntimeWorktreeTerminalSleepResult>

  private getWorktreeHostFence(
    worktree: { id: string; repoId?: string } & Parameters<typeof getWorktreeExecutionHostId>[0]
  ): WorktreePtyHostFence {
    const repo = worktree.repoId ? this.store?.getRepo?.(worktree.repoId) : undefined
    const parsedHost = parseExecutionHostId(getWorktreeExecutionHostId(worktree, repo))
    return parsedHost?.kind === 'runtime'
      ? { resolvedRuntimeEnvironmentId: parsedHost.environmentId }
      : { resolvedConnectionId: parsedHost?.kind === 'ssh' ? parsedHost.targetId : null }
  }

  /** `list`: whose terminals. The host's list closes its tabs first; a teammate's are stopped, then
   *  their saved tabs and resume records dropped from their own workspace. */
  async closeTerminalsForWorktree(
    worktreeSelector: string,
    { list = 'host' }: { list?: PtyList } = {}
  ): Promise<RuntimeWorktreeTerminalCloseResult> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const hostFence = this.getWorktreeHostFence(worktree)

    return await this.runWorktreeTerminalMutation(worktree.id, async () => {
      // A teammate's list's records are saved under their own workspace, in the teammates' partition.
      const listWorkspaceId = listSleepWorkspaceId(worktree.id, list)
      // Clearing a rotated partition can reroute ownership; retain the session host that held tabs when close began.
      const sessionHostId = this.getWorkspaceSessionHostIdForWorktree(listWorkspaceId)
      const hostTabs =
        list === 'host'
          ? await this.listMobileSessionTabs(`id:${worktree.id}`, undefined, {
              includeAgentSenders: false
            })
          : null
      const targetPtyIds = collectWorktreePtyIds(
        // Switch point: main's bound terminals too, registered or not.
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? withMainBoundLeaves(this, this.leaves.values())
          : this.leaves.values(),
        this.ptysById,
        worktree.id,
        hostFence,
        list,
        true
      )
      // Main-bound terminals can survive inventory gaps; only certified exits count them stopped.
      const mainBound = new Set(
        [...targetPtyIds].filter(
          (ptyId) => ORCA_LAYOUT_OWNER_IS_MAIN && mainHoldsTerminal(this, ptyId)
        )
      )
      let closed: number | null = null
      if (hostTabs) {
        const parentTabIds = [
          ...new Set(
            hostTabs.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.parentTabId] : []))
          )
        ]
        closed = await this.closeWorktreeTabsOwingPtyStops(worktree.id, parentTabIds)
        await this.clearWorktreeTerminalResumeRecords(worktree.id, sessionHostId, parentTabIds)
      }
      const { stopped } = await this.stopTerminalsForWorktree(`id:${worktree.id}`, {
        list,
        resolvedWorktreeId: worktree.id,
        ...hostFence
      })
      if (!hostTabs) {
        // No window closes their tabs: their saved ones, slept ones included, go with their records.
        await this.commitWorkspaceSessionEdit(sessionHostId, (session) =>
          clearWorkspaceTerminals(session, listWorkspaceId)
        )
      }
      const ptyStop = summarizeWorktreePtyStopVerdict(
        targetPtyIds,
        (ptyId) => this.getPtyLivenessVerdict(ptyId),
        (ptyId) =>
          this.ptysById.get(ptyId)?.connected === true ||
          mainBound.has(ptyId) ||
          (this.isSshOwnedPtyId(ptyId) && this.ptysById.has(ptyId))
      )
      return {
        closed: closed ?? stopped,
        stopped,
        retiredSurfaces: true,
        ...ptyStop
      }
    })
  }

  private async clearWorktreeTerminalResumeRecords(
    worktreeId: string,
    hostId: WorkspaceSessionPartitionId,
    closedTabIds: readonly string[]
  ): Promise<void> {
    await this.commitWorkspaceSessionEdit(hostId, (session) =>
      clearClosedWorktreeResumeRecords(session, worktreeId, closedTabIds)
    )
  }

  /** Durably replaces a host partition's session with `edit`'s result: null skips, an Error refuses. */
  protected async commitWorkspaceSessionEdit(
    hostId: WorkspaceSessionPartitionId,
    edit: (session: WorkspaceSessionState) => WorkspaceSessionState | Error | null
  ): Promise<void> {
    if (
      !this.store?.getWorkspaceSession ||
      !this.store.setWorkspaceSession ||
      !this.store.runDurableMutation
    ) {
      throw new Error('workspace_session_unavailable')
    }
    const refusal = await this.store.runDurableMutation<Error | undefined>(() => {
      // SAFETY: Keep the original late lookup and failure if this capability disappears.
      const session = cloneWorkspaceSessionState(this.store!.getWorkspaceSession!(hostId))
      const next = edit(session)
      if (next instanceof Error) {
        return { value: next, persist: false }
      }
      if (!next) {
        return { value: undefined, persist: false }
      }
      // SAFETY: Keep the original late lookup and failure if this capability disappears.
      this.store!.setWorkspaceSession!(next, hostId)
      // SAFETY: Keep the original late lookup and failure if this capability disappears.
      const staged = cloneWorkspaceSessionState(this.store!.getWorkspaceSession!(hostId))
      return {
        value: undefined,
        rollback: () => {
          // SAFETY: Keep the original late lookup and failure if this capability disappears.
          const current = this.store!.getWorkspaceSession!(hostId)
          const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(session, staged, current)
          if (rolledBack !== current) {
            // SAFETY: Keep the original late lookup and failure if this capability disappears.
            this.store!.setWorkspaceSession!(rolledBack, hostId)
          }
        }
      }
    })
    if (refusal) {
      throw refusal
    }
  }

  async stopTerminalsForWorktree(
    worktreeSelector: string,
    options: WorktreeTerminalStopOptions
  ): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so reject while the graph is reloading rather than act on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = options.resolvedWorktreeId
      ? { id: options.resolvedWorktreeId }
      : await this.resolveWorkspaceSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const pastDeadline = (): boolean =>
      options.deadline !== undefined && Date.now() >= options.deadline
    if (pastDeadline() && !options.requestStopsPastDeadline) {
      return { stopped: 0 }
    }
    // Preserve folder-instance suffixes while normalizing cross-platform path spelling.
    const hostFence =
      options.resolvedWorktreeId ||
      options.resolvedConnectionId !== undefined ||
      options.resolvedRuntimeEnvironmentId !== undefined
        ? options
        : this.getWorktreeHostFence(worktree)
    const ptyIds = collectWorktreePtyIds(
      // Switch point: main's bound terminals too, registered or not.
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? withMainBoundLeaves(this, this.leaves.values())
        : this.leaves.values(),
      this.ptysById,
      worktree.id,
      hostFence,
      options.list
    )

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (pastDeadline()) {
        if (!options.requestStopsPastDeadline) {
          break
        }
        // Unverified, so never counted: the budget bounds the wait, not who is asked to stop.
        this.requestPtyStopWithoutWaiting(ptyId)
        continue
      }
      const stop = async (): Promise<boolean> => {
        if (pastDeadline()) {
          return false
        }
        try {
          // Why: terminal.stop is a durable receipt; wait for provider exit so
          // onPtyExit de-persists the tab before returning.
          if (this.ptyController?.stopAndWait) {
            // Why: the RPC deadline makes shutdown/list RPCs settle before the sweep deadline.
            if (options.deadline !== undefined) {
              return await this.ptyController.stopAndWait(ptyId, {
                deadlineMs: teardownRpcDeadline(options.deadline)
              })
            }
            return await this.ptyController.stopAndWait(ptyId)
          }
          return Boolean(this.ptyController?.kill(ptyId))
        } catch (error) {
          // A worktree sweep is best-effort per PTY; continue after provider errors.
          console.warn(`[runtime] failed to stop terminal ${ptyId}`, error)
          return false
        }
      }
      const stopResult = options.stopPty
        ? await options.stopPty(ptyId, stop)
        : { stopped: await stop(), owner: true }
      if (stopResult.owner && stopResult.stopped) {
        stopped += 1
      }
    }
    return { stopped }
  }

  private requestPtyStopWithoutWaiting(ptyId: string): void {
    try {
      this.ptyController?.kill(ptyId)
    } catch (error) {
      console.warn(`[runtime] failed to request a stop for terminal ${ptyId}`, error)
    }
  }

  /** With `soleLivePtyId`, stops nothing unless that PTY is the worktree's only live terminal.
   *  `list`: whose terminals (the host list's by default). */
  async sleepTerminalsForWorktree(
    worktreeSelector: string,
    options: { soleLivePtyId?: string; list?: PtyList } = {}
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    const scope = resolveSleepScope(this.store?.getRepos() ?? [], worktree, options.list)
    const existing = this.terminalSleepByHostWorktree.get(scope.key)
    if (existing) {
      return await existing
    }
    if (options.soleLivePtyId) {
      // Why not shared: a full sleep joining this one would get back a sleep that stopped nothing.
      return await this.sleepResolvedWorktreeTerminals(worktree, scope, options.soleLivePtyId)
    }

    const sleeping = this.sleepResolvedWorktreeTerminals(worktree, scope)
    this.terminalSleepByHostWorktree.set(scope.key, sleeping)
    try {
      return await sleeping
    } finally {
      if (this.terminalSleepByHostWorktree.get(scope.key) === sleeping) {
        this.terminalSleepByHostWorktree.delete(scope.key)
      }
    }
  }

  /** Whether the host itself has put (or is putting) this worktree's terminals to sleep. */
  protected isWorktreeTerminalSleepHeld(worktreeId: string): boolean {
    return anySleepKeyNames(this.terminalSleepStateByHostWorktree.keys(), worktreeId)
  }

  protected async runWorktreeTerminalMutation<T>(
    worktreeId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    // Adoption reconciles terminal records and must exclude concurrent spawns and sleeps.
    const release = await this.acquireWorktreeTerminalMutation(worktreeId, 'exclusive')
    try {
      return await operation()
    } finally {
      release()
    }
  }

  protected async acquireWorktreeTerminalMutation(
    worktreeId: string,
    kind: WorktreeTerminalMutationKind,
    deadline?: number
  ): Promise<() => void> {
    return await this.terminalMutationLock.acquire(worktreeIdentityKey(worktreeId), kind, deadline)
  }
}
