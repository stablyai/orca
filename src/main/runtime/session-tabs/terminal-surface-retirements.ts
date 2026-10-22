import type { OrcaRuntimeWithBindPtyIncarnationHandle as BindPtyIncarnationHandleMethods } from '../terminal/identity/terminal-handle-bindings'
import { OrcaRuntimeWithTouchMobileSessionTabsForWorktree } from './mobile-session-membership'
import type { RetiredTerminalSurface } from '../mobile-session-terminal-retirement'
import type { RuntimeMobileSessionRetiredTerminalSurface } from '../../../shared/runtime-types'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { keepsExitedPane } from '../exited-split-pane-layout-close'
import type { ExitedSplitPaneFacts } from '../terminal/lifecycle/exited-split-pane-rule'
import { retireTerminalSurfaceFromPersistence } from '../mobile-session-terminal-persistence-retirement'
import { retireTerminalSurfacesFromSnapshot } from '../mobile-session-terminal-retirement'
import { attachRetirementProofsToSnapshot } from '../mobile-session-terminal-retirement-proof'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

export abstract class OrcaRuntimeWithPersistTerminalSurfaceRetirements extends OrcaRuntimeWithTouchMobileSessionTabsForWorktree {
  protected abstract findHandleForPtyRecord(
    ...args: Parameters<BindPtyIncarnationHandleMethods['findHandleForPtyRecord']>
  ): ReturnType<BindPtyIncarnationHandleMethods['findHandleForPtyRecord']>

  /**
   * Retires each surface in the in-memory session partition of the host that owns its worktree.
   * Why: an SSH pane's durable surface lives in that connection's partition; retiring it
   * against the local partition strands the real ghost and bumps a foreign host's epoch.
   * `accepted` held the surface; `unpersisted` had no partition to hold it (or refused the write);
   * `kept` is an exited pane main keeps, so no client is told it retired.
   */
  protected stageTerminalSurfaceRetirements(
    retiredSurfaces: readonly RetiredTerminalSurface[],
    exit?: ExitedSplitPaneFacts
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
      // Switch point: main keeps an exited pane the window's rule keeps; others retire as before.
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        exit &&
        parseExecutionHostId(hostId)?.kind !== 'runtime' &&
        keepsExitedPane(current, surface, exit)
      ) {
        kept.push(surface)
        continue
      }
      const next = retireTerminalSurfaceFromPersistence(current, surface)
      if (next === current) {
        continue
      }
      try {
        // The existing catch handles a missing store setter.
        this.store!.setWorkspaceSession!(next, hostId)
        accepted.push(surface)
      } catch (error) {
        // Why: the process is gone whether or not the profile admits the write (quit, maintenance).
        console.error('[runtime] could not stage terminal retirement:', error)
        unpersisted.push(surface)
      }
    }
    return { accepted, unpersisted, kept }
  }

  // Why no rollback: the process is gone, so a failed write leaves the retirement for the next one.
  protected async persistStagedTerminalSurfaceRetirements(): Promise<void> {
    if (!this.store?.runDurableMutation) {
      return
    }
    try {
      // Why if-dirty: an earlier write, or another exit's, may already carry this retirement.
      await this.store.runDurableMutation(() => ({ value: undefined, persist: 'if-dirty' }))
    } catch (error) {
      console.error('[runtime] terminal retirement is not yet durable:', error)
    }
  }

  // Why synchronous: the exit's stream end cues clients to re-activate, which must find the leaf gone.
  protected retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[],
    exit?: ExitedSplitPaneFacts
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
    const staged = this.stageTerminalSurfaceRetirements(retiredSurfaces, exit)
    for (const surface of staged.unpersisted) {
      const repoId = getRepoIdFromWorktreeId(surface.worktreeId)
      this.terminalTopologyRevisionByRepoId.set(
        repoId,
        (this.terminalTopologyRevisionByRepoId.get(repoId) ?? 0) + 1
      )
    }
    // Why: one repo epoch can cover multiple exits; a surface the session binds to another PTY or incarnation stays.
    const removableRetiredSurfaces = [...staged.accepted, ...staged.unpersisted]
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      // Why proofs aren't gated on `removable`: the exit is the attestation, and a surface the
      // renderer already de-persisted leaves persistence nothing to accept. Withholding the proof
      // then strands the mirror's pane until a second inventory a quiet workspace never sends.
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
              // Why: discovery is broad by PTY id, but publication may remove only surfaces the session retired.
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
