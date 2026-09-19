// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveTerminalSplitSourceAuthority } from './orca-runtime-resolve-terminal-split-source-authority'
import {
  runtimeWorktreeIdentityKey,
  runtimeWorktreeIdsEqual
} from './runtime-worktree-path-identity'
import { teardownRpcDeadline } from './worktree-teardown'
import type {
  RuntimeWorktreeTerminalCloseResult,
  RuntimeWorktreeTerminalSleepResult
} from '../../shared/runtime-types'
import type { WorktreeTerminalMutationKind } from './worktree-terminal-mutation-lock'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { worktreePtyBelongsToHost, type WorktreePtyHostFence } from './worktree-pty-host-fence'
import { summarizeWorktreePtyStopVerdict } from './worktree-pty-stop-verdict'

export class OrcaRuntimeWithStopTerminalsForWorktree extends OrcaRuntimeWithResolveTerminalSplitSourceAuthority {
  private collectWorktreePtyIds(
    worktreeId: string,
    hostFence: WorktreePtyHostFence,
    includeDisconnected = false
  ): Set<string> {
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (
        runtimeWorktreeIdsEqual(leaf.worktreeId, worktreeId) &&
        leaf.ptyId &&
        worktreePtyBelongsToHost(leaf.ptyId, this.ptysById.get(leaf.ptyId)?.connectionId, hostFence)
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (
        runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId) &&
        (includeDisconnected || pty.connected) &&
        worktreePtyBelongsToHost(pty.ptyId, pty.connectionId, hostFence)
      ) {
        ptyIds.add(pty.ptyId)
      }
    }
    return ptyIds
  }

  private getWorktreeHostFence(worktree: { id: string; repoId?: string }): WorktreePtyHostFence {
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
      const targetPtyIds = this.collectWorktreePtyIds(worktree.id, hostFence, true)
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
          throw new Error(result.refusalReason ?? 'terminal_close_refused')
        }
        closed += 1
      }
      this.clearWorktreeTerminalResumeRecords(worktree.id, sessionHostId, parentTabIds)
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

  private clearWorktreeTerminalResumeRecords(
    worktreeId: string,
    hostId: ExecutionHostId,
    closedTabIds: readonly string[]
  ): void {
    if (
      !this.store?.getWorkspaceSession ||
      !this.store.setWorkspaceSession ||
      !this.store.flushOrThrow
    ) {
      throw new Error('workspace_session_unavailable')
    }
    const session = this.store.getWorkspaceSession(hostId)
    const sleepingAgentSessionsByPaneKey = Object.fromEntries(
      Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).filter(
        ([, record]) => record.worktreeId !== worktreeId
      )
    )
    const terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {}).filter(
        ([paneKey]) => !closedTabIds.some((tabId) => paneKey.startsWith(`${tabId}:`))
      )
    )
    const remainingTerminalRows = session.tabsByWorktree[worktreeId] ?? []
    const remainingUnifiedTerminalTabs = (session.unifiedTabs?.[worktreeId] ?? []).filter(
      (tab) => tab.contentType === 'terminal'
    )
    if (remainingTerminalRows.length > 0 || remainingUnifiedTerminalTabs.length > 0) {
      throw new Error('terminal_close_incomplete')
    }
    const hasChanges =
      Object.keys(sleepingAgentSessionsByPaneKey).length !==
        Object.keys(session.sleepingAgentSessionsByPaneKey ?? {}).length ||
      Object.keys(terminalPtyIncarnationsByPaneKey).length !==
        Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).length
    if (!hasChanges) {
      return
    }
    const next: WorkspaceSessionState = {
      ...session,
      sleepingAgentSessionsByPaneKey,
      terminalPtyIncarnationsByPaneKey
    }
    this.store.setWorkspaceSession(next, hostId)
    const staged = this.store.getWorkspaceSession(hostId)
    try {
      this.store.flushOrThrow()
    } catch (error) {
      const current = this.store.getWorkspaceSession(hostId)
      const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(session, staged, current)
      if (rolledBack !== current) {
        this.store.setWorkspaceSession(rolledBack, hostId)
      }
      throw error
    }
  }

  async stopTerminalsForWorktree(
    worktreeSelector: string,
    options: {
      deadline?: number
      stopPty?: (
        ptyId: string,
        stop: () => Promise<boolean>
      ) => Promise<{ stopped: boolean; owner: boolean }>
      /** Authoritative id for an orphan whose selector no longer resolves. */
      resolvedWorktreeId?: string
      resolvedConnectionId?: string | null
      resolvedRuntimeEnvironmentId?: string
    } = {}
  ): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so reject while the graph is reloading rather than act on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = options.resolvedWorktreeId
      ? { id: options.resolvedWorktreeId }
      : await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { stopped: 0 }
    }
    // Preserve folder-instance suffixes while normalizing cross-platform path spelling.
    const hostFence =
      options.resolvedWorktreeId ||
      options.resolvedConnectionId !== undefined ||
      options.resolvedRuntimeEnvironmentId !== undefined
        ? options
        : this.getWorktreeHostFence(worktree)
    const ptyIds = this.collectWorktreePtyIds(worktree.id, hostFence)

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        break
      }
      const stop = async (): Promise<boolean> => {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
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

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const existing = this.terminalSleepByWorktreeId.get(worktree.id)
    if (existing) {
      return await existing
    }

    const sleeping = this.sleepResolvedWorktreeTerminals(worktree)
    this.terminalSleepByWorktreeId.set(worktree.id, sleeping)
    try {
      return await sleeping
    } finally {
      if (this.terminalSleepByWorktreeId.get(worktree.id) === sleeping) {
        this.terminalSleepByWorktreeId.delete(worktree.id)
      }
    }
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    if (!worktreeId) {
      return () => {}
    }
    const release = await this.acquireWorktreeTerminalMutation(worktreeId, 'shared')
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const sleepState = this.terminalSleepStateByWorktreeId.get(key)
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.terminalSleepStateByWorktreeId.delete(key)
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
    return await this.terminalMutationLock.acquire(
      runtimeWorktreeIdentityKey(worktreeId),
      kind,
      deadline
    )
  }
}
