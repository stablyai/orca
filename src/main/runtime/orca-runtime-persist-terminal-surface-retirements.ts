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
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

export class OrcaRuntimeWithPersistTerminalSurfaceRetirements extends OrcaRuntimeWithTouchMobileSessionTabsForWorktree {
  /**
   * Retires each surface in the session partition of the host that owns its worktree.
   * Why: an SSH pane's durable surface lives in that connection's partition; retiring it
   * against the local partition strands the real ghost and bumps a foreign host's epoch.
   * Returns null when nothing may be published because persistence is unavailable or failed.
   */
  protected persistTerminalSurfaceRetirements(
    retiredSurfaces: readonly RetiredTerminalSurface[]
  ): { accepted: RetiredTerminalSurface[]; unpersisted: RetiredTerminalSurface[] } | null {
    const surfacesByHostId = new Map<ExecutionHostId, RetiredTerminalSurface[]>()
    for (const surface of retiredSurfaces) {
      const hostId =
        this.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ?? LOCAL_EXECUTION_HOST_ID
      const bucket = surfacesByHostId.get(hostId)
      if (bucket) {
        bucket.push(surface)
      } else {
        surfacesByHostId.set(hostId, [surface])
      }
    }
    const accepted: RetiredTerminalSurface[] = []
    const unpersisted: RetiredTerminalSurface[] = []
    const pendingWrites: { hostId: ExecutionHostId; session: WorkspaceSessionState }[] = []
    const originalSessions = new Map<ExecutionHostId, WorkspaceSessionState>()
    const stagedSessions = new Map<ExecutionHostId, WorkspaceSessionState>()
    for (const [hostId, surfaces] of surfacesByHostId) {
      const session = this.store?.getWorkspaceSession?.(hostId)
      if (!session) {
        unpersisted.push(...surfaces)
        continue
      }
      // Why: publishing absence before its host membership fence is durable lets a crash or
      // stale renderer write resurrect the retired surface.
      if (!this.store?.setWorkspaceSession || !this.store.flushOrThrow) {
        return null
      }
      originalSessions.set(hostId, session)
      let nextSession = session
      const acceptedForHost: RetiredTerminalSurface[] = []
      for (const surface of surfaces) {
        const candidate = retireTerminalSurfaceFromPersistence(nextSession, surface)
        if (candidate !== nextSession) {
          acceptedForHost.push(surface)
          nextSession = candidate
        }
      }
      if (acceptedForHost.length === 0) {
        continue
      }
      accepted.push(...acceptedForHost)
      pendingWrites.push({ hostId, session: nextSession })
    }
    if (pendingWrites.length > 0) {
      try {
        for (const write of pendingWrites) {
          this.store?.setWorkspaceSession?.(write.session, write.hostId)
          const staged = this.store?.getWorkspaceSession?.(write.hostId)
          if (staged) {
            stagedSessions.set(write.hostId, staged)
          }
        }
        this.store?.flushOrThrow?.()
      } catch (error) {
        // setWorkspaceSession mutates the in-memory partition before the flush. Restore only
        // fields still equal to our staged write so concurrent renderer updates survive.
        for (const [hostId, original] of originalSessions) {
          const staged = stagedSessions.get(hostId)
          const current = this.store?.getWorkspaceSession?.(hostId)
          if (!staged || !current) {
            continue
          }
          const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(
            original,
            staged,
            current
          )
          if (rolledBack !== current) {
            this.store?.setWorkspaceSession?.(rolledBack, hostId)
          }
        }
        console.error('[runtime] failed to persist terminal retirement:', error)
        return null
      }
    }
    return { accepted, unpersisted }
  }

  protected retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[]
  ): void {
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
    const persisted = this.persistTerminalSurfaceRetirements(retiredSurfaces)
    if (!persisted) {
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
      // Why proofs are not gated on `removable`: the observed exit is itself the attestation that
      // this surface is retired. Persistence gates *removal* — publishing absence before the
      // membership fence is durable would let a crash resurrect the surface — but a surface the
      // renderer's own close transaction already de-persisted and dropped leaves persistence with
      // nothing to accept, and gating the proof on that acceptance withheld the one piece of host
      // evidence a paired mirror can act on. Its only other route needs two authoritative
      // inventories, and a quiet workspace publishes one frame, so the pane stayed forever.
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
