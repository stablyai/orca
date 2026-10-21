import { OrcaRuntimeWithResolveTerminalSplitSourceAuthority } from '../launch/terminal-split-source-authority'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import { teardownRpcDeadline } from '../../worktree-teardown-deadline'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../../worktree-terminals-sleeping-error'
import type {
  RuntimeWorktreeTerminalCloseResult,
  RuntimeWorktreeTerminalSleepResult
} from '../../../../shared/runtime-types'
import type { WorktreeTerminalStopOptions } from './worktree-terminal-stop-options'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeTerminalMutationKind } from '../../worktree-terminal-mutation-lock'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { cloneWorkspaceSessionState } from '../../../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../../persistence/restoring-sessions/workspace-session-write-rollback'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { WorktreePtyHostFence } from '../../worktree-pty-host-fence'
import { collectWorktreePtyIds } from './worktree-pty-collection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { withMainBoundLeaves } from '../surface/main-terminal-surfaces'
import { summarizeWorktreePtyStopVerdict } from '../../worktree-pty-stop-verdict'
import { describeMobileSessionTabCloseRefusal } from '../../mobile-session-tab-close-refusal-message'
import { clearClosedWorktreeResumeRecords } from './worktree-sleep-resume-records'
import { anySleepKeyNames, hostSleepKey, resolveSleepScope } from './worktree-terminal-sleep-key'
import type { WorktreeSleepScope } from './worktree-terminal-sleep-key'

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

  async closeTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalCloseResult> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const hostFence = this.getWorktreeHostFence(worktree)

    return await this.runWorktreeTerminalMutation(worktree.id, async () => {
      // Why: emptying a rotated runtime partition re-routes the session owner, so the
      // records cleared below live in the partition that owned the tabs at the start.
      const sessionHostId = this.getWorkspaceSessionHostIdForWorktree(worktree.id)
      const snapshot = await this.listMobileSessionTabs(`id:${worktree.id}`)
      const targetPtyIds = collectWorktreePtyIds(
        // Switch point: main's bound terminals too, registered or not.
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? withMainBoundLeaves(this, this.leaves.values())
          : this.leaves.values(),
        this.ptysById,
        worktree.id,
        hostFence,
        true
      )
      const parentTabIds = [
        ...new Set(
          snapshot.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.parentTabId] : []))
        )
      ]
      let closed = 0
      for (const parentTabId of parentTabIds) {
        const result = await this.closeMobileSessionTab(`id:${worktree.id}`, parentTabId, {
          reason: 'user',
          force: true,
          localPtyTeardownOwnedExternally: true
        })
        if (result.refused) {
          throw new Error(describeMobileSessionTabCloseRefusal(result.refusalReason))
        }
        closed += 1
      }
      await this.clearWorktreeTerminalResumeRecords(worktree.id, sessionHostId, parentTabIds)
      const { stopped } = await this.stopTerminalsForWorktree(`id:${worktree.id}`, {
        resolvedWorktreeId: worktree.id,
        ...hostFence
      })
      const ptyStop = summarizeWorktreePtyStopVerdict(
        targetPtyIds,
        (ptyId) => this.getPtyLivenessVerdict(ptyId),
        (ptyId) =>
          this.ptysById.get(ptyId)?.connected === true ||
          (this.isSshOwnedPtyId(ptyId) && this.ptysById.has(ptyId))
      )
      return {
        closed,
        stopped,
        retiredSurfaces: true,
        ...ptyStop
      }
    })
  }

  private async clearWorktreeTerminalResumeRecords(
    worktreeId: string,
    hostId: ExecutionHostId,
    closedTabIds: readonly string[]
  ): Promise<void> {
    await this.commitWorkspaceSessionEdit(hostId, (session) =>
      clearClosedWorktreeResumeRecords(session, worktreeId, closedTabIds)
    )
  }

  /** Durably replaces a host partition's session with `edit`'s result: null skips, an Error refuses. */
  protected async commitWorkspaceSessionEdit(
    hostId: ExecutionHostId,
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
    options: WorktreeTerminalStopOptions = {}
  ): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so reject while the graph is reloading rather than act on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = options.resolvedWorktreeId
      ? { id: options.resolvedWorktreeId }
      : await this.resolveWorktreeSelector(worktreeSelector)
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
      hostFence
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

  /** With `soleLivePtyId`, stops nothing unless that PTY is the worktree's only live terminal. */
  async sleepTerminalsForWorktree(
    worktreeSelector: string,
    options: { soleLivePtyId?: string } = {}
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const scope = resolveSleepScope(this.store?.getRepos() ?? [], worktree)
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

  /** `target` is the spawn's own workspace copy: the host whose provider runs it. */
  async acquireWorktreeTerminalSpawn(
    target: HostWorktreeTarget | undefined,
    opts: { refuseSleptWorktree?: boolean } = {}
  ): Promise<() => void> {
    if (!target) {
      return () => {}
    }
    const worktreeId = target.id
    const release = await this.acquireWorktreeTerminalMutation(worktreeId, 'shared')
    const key = hostSleepKey(target.hostId, worktreeId)
    const sleepState = this.terminalSleepStateByHostWorktree.get(key)
    // Why: re-checked under the lock, since a sleep can commit while an automatic spawn waits for it.
    if (sleepState && opts.refuseSleptWorktree) {
      release()
      throw new Error(WORKTREE_TERMINALS_SLEEPING_ERROR)
    }
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.terminalSleepStateByHostWorktree.delete(key)
      this.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: sleepState.worktreeId,
        generation: sleepState.generation,
        phase: 'woken',
        ptyIds: sleepState.ptyIds,
        terminalHandles: sleepState.terminalHandles
      })
    }
    return release
  }

  /** Whether the host itself has put (or is putting) this worktree's terminals to sleep. */
  protected isWorktreeTerminalSleepHeld(worktreeId: string): boolean {
    return anySleepKeyNames(this.terminalSleepStateByHostWorktree.keys(), worktreeId)
  }

  protected async runWorktreeTerminalMutation<T>(
    worktreeId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    // Why exclusive: adoption reconciles this worktree's terminal records, so
    // it must not interleave with a spawn registering a pty or with a sleep.
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
