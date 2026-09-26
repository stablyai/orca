// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTouchMobileSessionTabsForWorktree } from './orca-runtime-touch-mobile-session-tabs-for-worktree'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeMobileSessionRetiredTerminalSurface } from '../../shared/runtime-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import { attachRetirementProofsToSnapshot } from './mobile-session-terminal-retirement-proof'
import { cloneWorkspaceSessionState } from '../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../persistence/restoring-sessions/workspace-session-write-rollback'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

export class OrcaRuntimeWithPersistTerminalSurfaceRetirements extends OrcaRuntimeWithTouchMobileSessionTabsForWorktree {
  /**
   * Retires each surface in the session partition of the host that owns its worktree.
   * Why: an SSH pane's durable surface lives in that connection's partition; retiring it
   * against the local partition strands the real ghost and bumps a foreign host's epoch.
   * Returns null when nothing may be published because persistence is unavailable or failed.
   */
  protected async persistTerminalSurfaceRetirements(
    retiredSurfaces: readonly RetiredTerminalSurface[]
  ): Promise<{ accepted: RetiredTerminalSurface[]; unpersisted: RetiredTerminalSurface[] } | null> {
    if (!this.store?.runDurableMutation) {
      const hasPersistedSession = retiredSurfaces.some((surface) =>
        this.store?.getWorkspaceSession?.(
          this.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ??
            LOCAL_EXECUTION_HOST_ID
        )
      )
      return hasPersistedSession ? null : { accepted: [], unpersisted: [...retiredSurfaces] }
    }
    try {
      return await this.store.runDurableMutation(() => {
        const accepted: RetiredTerminalSurface[] = []
        const unpersisted: RetiredTerminalSurface[] = []
        const originals = new Map<ExecutionHostId, WorkspaceSessionState>()
        const staged = new Map<ExecutionHostId, WorkspaceSessionState>()
        for (const surface of retiredSurfaces) {
          const hostId =
            this.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ??
            LOCAL_EXECUTION_HOST_ID
          const current = this.store.getWorkspaceSession?.(hostId)
          if (!current) {
            unpersisted.push(surface)
            continue
          }
          if (!this.store.setWorkspaceSession) {
            throw new Error('workspace_session_unavailable')
          }
          if (!originals.has(hostId)) {
            originals.set(hostId, cloneWorkspaceSessionState(current))
          }
          const next = retireTerminalSurfaceFromPersistence(current, surface)
          if (next !== current) {
            this.store.setWorkspaceSession(next, hostId)
            staged.set(hostId, cloneWorkspaceSessionState(this.store.getWorkspaceSession(hostId)))
            accepted.push(surface)
          }
        }
        return {
          value: { accepted, unpersisted },
          persist: staged.size > 0,
          rollback: () => {
            for (const [hostId, stagedSession] of staged) {
              const current = this.store.getWorkspaceSession(hostId)
              const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(
                originals.get(hostId),
                stagedSession,
                current
              )
              if (rolledBack !== current) {
                this.store.setWorkspaceSession(rolledBack, hostId)
              }
            }
          }
        }
      })
    } catch (error) {
      console.error('[runtime] failed to persist terminal retirement:', error)
      return null
    }
  }

  protected async retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[]
  ): Promise<void> {
    // Reads can mint a new frame generation while this independent retirement waits for disk.
    const pendingRetirement = this.pendingPtySurfaceRetirementsByPtyId.get(ptyId)
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
      return
    }
    const persisted = await this.persistTerminalSurfaceRetirements(retiredSurfaces)
    const currentIncarnation = this.ptysById.get(ptyId)?.incarnationId
    if (
      !persisted ||
      this.pendingPtySurfaceRetirementsByPtyId.get(ptyId) !== pendingRetirement ||
      (currentIncarnation && currentIncarnation !== incarnationId)
    ) {
      return
    }
    for (const surface of persisted.unpersisted) {
      const repoId = getRepoIdFromWorktreeId(surface.worktreeId)
      this.terminalTopologyRevisionByRepoId.set(
        repoId,
        (this.terminalTopologyRevisionByRepoId.get(repoId) ?? 0) + 1
      )
    }
    // Why: one repo epoch can cover multiple exits, but only surfaces individually accepted by persistence may disappear.
    const removableRetiredSurfaces = [...persisted.accepted, ...persisted.unpersisted]
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      // Why proofs aren't gated on `removable`: the exit is the attestation, and a surface the
      // renderer already de-persisted leaves persistence nothing to accept. Withholding the proof
      // then strands the mirror's pane until a second inventory a quiet workspace never sends.
      const retirementProofs = terminalHandle
        ? retiredSurfaces
            .filter((surface) => surface.worktreeId === worktreeId)
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
              // Why: discovery is broad by PTY id, but publication may remove only surfaces whose durable retirement was accepted.
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
