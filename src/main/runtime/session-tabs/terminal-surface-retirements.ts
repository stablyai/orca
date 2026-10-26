import type { OrcaRuntimeWithBindPtyIncarnationHandle as BindPtyIncarnationHandleMethods } from '../terminal/identity/terminal-handle-bindings'
import { OrcaRuntimeWithTouchMobileSessionTabsForWorktree } from './mobile-session-membership'
import type { RetiredTerminalSurface } from '../mobile-session-terminal-retirement'
import type { RuntimeMobileSessionRetiredTerminalSurface } from '../../../shared/runtime-types'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { keepsExitedPane } from '../exited-split-pane-layout-close'
import type { ExitedSplitPaneFacts } from '../terminal/lifecycle/exited-split-pane-rule'
import {
  forgetClosedPaneOfExit,
  type ClosedPaneOfExit
} from '../terminal/lifecycle/closed-pane-of-exited-pty'
import { retireTerminalSurfaceFromPersistence } from '../mobile-session-terminal-persistence-retirement'
import { retireTerminalSurfacesFromSnapshot } from '../mobile-session-terminal-retirement'
import { attachRetirementProofsToSnapshot } from '../mobile-session-terminal-retirement-proof'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

export abstract class OrcaRuntimeWithPersistTerminalSurfaceRetirements extends OrcaRuntimeWithTouchMobileSessionTabsForWorktree {
  protected abstract findHandleForPtyRecord(
    ...args: Parameters<BindPtyIncarnationHandleMethods['findHandleForPtyRecord']>
  ): ReturnType<BindPtyIncarnationHandleMethods['findHandleForPtyRecord']>

  /** Retire in the owning host partition; local writes strand SSH ghosts and alter foreign epochs. accepted=held surface, unpersisted=absent/refused partition, kept=main-retained exited pane. Remove closedPane in the same write. */
  protected stageTerminalSurfaceRetirements(
    retiredSurfaces: readonly RetiredTerminalSurface[],
    exit?: ExitedSplitPaneFacts,
    closedPane?: ClosedPaneOfExit
  ): {
    accepted: RetiredTerminalSurface[]
    unpersisted: RetiredTerminalSurface[]
    kept: RetiredTerminalSurface[]
  } {
    const accepted: RetiredTerminalSurface[] = []
    const unpersisted: RetiredTerminalSurface[] = []
    const kept: RetiredTerminalSurface[] = []
    for (const surface of retiredSurfaces) {
      const hostId =
        this.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ?? LOCAL_EXECUTION_HOST_ID
      const current = this.store?.getWorkspaceSession?.(hostId)
      if (!current) {
        unpersisted.push(surface)
        continue
      }
      // Main retains exited panes matching window retention rules; retire all others normally.
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        exit &&
        parseExecutionHostId(hostId)?.kind !== 'runtime' &&
        keepsExitedPane(current, surface, exit)
      ) {
        kept.push(surface)
        continue
      }
      const retired = retireTerminalSurfaceFromPersistence(current, surface)
      const next =
        retired !== current && closedPane?.paneKey === `${surface.parentTabId}:${surface.leafId}`
          ? forgetClosedPaneOfExit(retired, closedPane)
          : retired
      if (next === current) {
        continue
      }
      try {
        // The existing catch handles a missing store setter.
        this.store!.setWorkspaceSession!(next, hostId)
        accepted.push(surface)
      } catch (error) {
        // The process is gone even when quit/maintenance prevents profile writes.
        console.error('[runtime] could not stage terminal retirement:', error)
        unpersisted.push(surface)
      }
    }
    return { accepted, unpersisted, kept }
  }

  // No rollback: failed writes retry retirement later, but the process is already gone.
  protected async persistStagedTerminalSurfaceRetirements(): Promise<void> {
    if (!this.store?.runDurableMutation) {
      return
    }
    try {
      // Write only if dirty; earlier/concurrent exits may already have persisted retirement.
      await this.store.runDurableMutation(() => ({ value: undefined, persist: 'if-dirty' }))
    } catch (error) {
      console.error('[runtime] terminal retirement is not yet durable:', error)
    }
  }

  // Retire synchronously before stream end prompts client reactivation.
  protected retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[],
    exit?: ExitedSplitPaneFacts,
    closedPane?: ClosedPaneOfExit
  ): Promise<void> | undefined {
    const terminalHandle =
      this.handleByPtyId.get(ptyId) ?? this.findHandleForPtyRecord(ptyId) ?? undefined
    const retiredSurfaceByKey = new Map<string, RetiredTerminalSurface>()
    for (const surface of exactSurfaces) {
      retiredSurfaceByKey.set(`${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`, {
        ...surface,
        ptyId,
        incarnationId
      })
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: exactSurfaces.filter((surface) => surface.worktreeId === worktreeId),
        exactOnly: exactSurfaces.length > 0
      })
      if (!retired) {
        continue
      }
      for (const surface of retired.retired) {
        retiredSurfaceByKey.set(
          `${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`,
          { ...surface, incarnationId }
        )
      }
    }
    const retiredSurfaces = [...retiredSurfaceByKey.values()]
    if (retiredSurfaces.length === 0) {
      return undefined
    }
    const staged = this.stageTerminalSurfaceRetirements(retiredSurfaces, exit, closedPane)
    for (const surface of staged.unpersisted) {
      const repoId = getRepoIdFromWorktreeId(surface.worktreeId)
      this.terminalTopologyRevisionByRepoId.set(
        repoId,
        (this.terminalTopologyRevisionByRepoId.get(repoId) ?? 0) + 1
      )
    }
    // One repo epoch may cover many exits; preserve surfaces rebound to other PTYs/incarnations.
    const removableRetiredSurfaces = [...staged.accepted, ...staged.unpersisted]
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      // Exit itself attests retirement even if the renderer already removed persistence; withholding proof strands mirrors on quiet workspaces.
      const retirementProofs = terminalHandle
        ? retiredSurfaces
            .filter(
              (surface) => surface.worktreeId === worktreeId && !staged.kept.includes(surface)
            )
            .map((surface) => ({
              parentTabId: surface.parentTabId,
              leafId: surface.leafId,
              ptyId: surface.ptyId,
              terminal: terminalHandle,
              incarnationId
            }))
        : []
      const removableSurfaces = removableRetiredSurfaces.filter(
        (surface) => surface.worktreeId === worktreeId
      )
      const retired =
        removableSurfaces.length > 0
          ? retireTerminalSurfacesFromSnapshot({
              snapshot,
              ptyId,
              exactSurfaces: removableSurfaces,
              // Discover broadly by PTY id but publish removals only for retired session surfaces.
              exactOnly: true,
              ...(retirementProofs.length > 0 ? { retirementProofs } : {})
            })
          : null
      if (retired) {
        this.storeMobileSessionSnapshot(worktreeId, retired.snapshot)
        this.notifyMobileSessionTabsChanged(worktreeId)
        continue
      }
      this.publishRetiredTerminalSurfaceProofs(worktreeId, retirementProofs)
    }
    return staged.accepted.length > 0 ? this.persistStagedTerminalSurfaceRetirements() : undefined
  }

  /** Ships durable retirement proofs on their own frame when no surface removal carries them. */
  protected publishRetiredTerminalSurfaceProofs(
    worktreeId: string,
    proofs: readonly RuntimeMobileSessionRetiredTerminalSurface[]
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    const next = attachRetirementProofsToSnapshot(snapshot, proofs)
    if (!next) {
      return
    }
    this.storeMobileSessionSnapshot(worktreeId, next)
    this.notifyMobileSessionTabsChanged(worktreeId)
  }
}
