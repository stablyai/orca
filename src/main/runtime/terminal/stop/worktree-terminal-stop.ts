import { OrcaRuntimeWithCloseTerminalsForWorktree } from './worktree-terminal-close'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import { teardownRpcDeadline } from '../../workspaces/removal/worktree-teardown-deadline'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../../../../shared/workspace-sleep'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/runtime-terminal-contracts'
import type {
  WorktreePtyStopContext,
  WorktreeTerminalStopOptions
} from './worktree-terminal-stop-options'
import type { WorktreeRemovalTarget } from '../../workspaces/removal/worktree-removal-targets'
import { captureWorktreeTerminalStops } from './worktree-terminal-removal-snapshot'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeTerminalMutationKind } from '../../workspaces/lifecycle/worktree-terminal-mutation-lock'
import { collectWorktreePtyIds } from './worktree-pty-collection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { withMainBoundLeaves } from '../surface/main-terminal-surfaces'
import { anySleepKeyNames, hostSleepKey, resolveSleepScope } from './worktree-terminal-sleep-key'
import type { WorktreeSleepScope } from './worktree-terminal-sleep-key'

export abstract class OrcaRuntimeWithStopTerminalsForWorktree extends OrcaRuntimeWithCloseTerminalsForWorktree {
  protected abstract sleepResolvedWorktreeTerminals(
    worktree: ResolvedWorktree,
    scope: WorktreeSleepScope,
    soleLivePtyId?: string
  ): Promise<RuntimeWorktreeTerminalSleepResult>

  async stopTerminalsForWorktree(
    worktreeSelector: string,
    options: WorktreeTerminalStopOptions = {}
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
    options.snapshot?.assertCurrent()
    const ptyIds =
      options.snapshot?.ptyIds ??
      collectWorktreePtyIds(
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
      this.assertStableReadyGraph(graphEpoch)
      if (pastDeadline()) {
        if (!options.requestStopsPastDeadline) {
          break
        }
        // Unverified, so never counted: the budget bounds the wait, not who is asked to stop.
        this.requestPtyStopWithoutWaiting(ptyId)
        continue
      }
      const stop = async (context?: WorktreePtyStopContext): Promise<boolean> => {
        if (pastDeadline()) {
          return false
        }
        try {
          if (!options.stopPty) {
            options.snapshot?.assertCurrent(ptyId)
          }
          // Why: terminal.stop is a durable receipt; wait for provider exit so
          // onPtyExit de-persists the tab before returning.
          if (this.ptyController?.stopAndWait) {
            // Why: the RPC deadline makes shutdown/list RPCs settle before the sweep deadline.
            if (options.deadline !== undefined || options.snapshot || context) {
              return await this.ptyController.stopAndWait(ptyId, {
                ...(options.deadline !== undefined
                  ? { deadlineMs: teardownRpcDeadline(options.deadline) }
                  : {}),
                ...(options.snapshot
                  ? {
                      observeExitOnly: options.resolvedConnectionId === null,
                      expectedIncarnationId:
                        options.snapshot.records.get(ptyId)?.incarnationId ?? undefined
                    }
                  : {}),
                ...context
              })
            }
            return await this.ptyController.stopAndWait(ptyId)
          }
          return context?.expectedIncarnationId ? false : Boolean(this.ptyController?.kill(ptyId))
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

  async captureWorktreeTerminalStops(targets: readonly WorktreeRemovalTarget[]) {
    return captureWorktreeTerminalStops(targets, {
      acquire: (id) => this.acquireWorktreeTerminalMutation(id, 'exclusive', Date.now() + 10_000),
      captureFence: () => {
        const epoch = this.captureReadyGraphEpoch()
        return () => this.assertStableReadyGraph(epoch)
      },
      leaves: () =>
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? withMainBoundLeaves(this, this.leaves.values())
          : this.leaves.values(),
      ptys: this.ptysById
    })
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
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
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
