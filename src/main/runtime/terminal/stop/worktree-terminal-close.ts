import { OrcaRuntimeWithResolveTerminalSplitSourceAuthority } from '../launch/terminal-split-source-authority'
import type { RuntimeWorktreeTerminalCloseResult } from '../../../../shared/runtime-terminal-contracts'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { cloneWorkspaceSessionState } from '../../../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../../persistence/restoring-sessions/workspace-session-write-rollback'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { WorktreePtyHostFence } from '../../workspaces/removal/worktree-pty-host-fence'
import { collectWorktreePtyIds } from './worktree-pty-collection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { withMainBoundLeaves } from '../surface/main-terminal-surfaces'
import { mainHoldsTerminal } from '../surface/main-pane-verdict'
import { summarizeWorktreePtyStopVerdict } from '../../workspaces/removal/worktree-pty-stop-verdict'
import { describeMobileSessionTabCloseRefusal } from '../../session-lifecycle/close/mobile-session-tab-close-refusal-message'
import { clearClosedWorktreeResumeRecords } from './worktree-sleep-resume-records'

export abstract class OrcaRuntimeWithCloseTerminalsForWorktree extends OrcaRuntimeWithResolveTerminalSplitSourceAuthority {
  protected getWorktreeHostFence(
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
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const hostFence = this.getWorktreeHostFence(worktree)

    return await this.runWorktreeTerminalMutation(worktree.id, async () => {
      // Clearing a rotated partition can reroute ownership; retain the session host that held tabs when close began.
      const sessionHostId = this.getWorkspaceSessionHostIdForWorktree(worktree.id)
      const snapshot = await this.listMobileSessionTabs(`id:${worktree.id}`, undefined, {
        includeAgentSenders: false
      })
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
      // Main-bound terminals can survive inventory gaps; only certified exits count them stopped.
      const mainBound = new Set(
        [...targetPtyIds].filter(
          (ptyId) => ORCA_LAYOUT_OWNER_IS_MAIN && mainHoldsTerminal(this, ptyId)
        )
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
          mainBound.has(ptyId) ||
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
}
