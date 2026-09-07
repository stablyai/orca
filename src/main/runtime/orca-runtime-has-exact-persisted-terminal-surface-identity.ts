// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithFenceAutomationOwner } from './orca-runtime-fence-automation-owner'
import {
  resolveTerminalSessionWorktreeId,
  runtimeWorktreeIdsEqual
} from './runtime-worktree-path-identity'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryInventory,
  TerminalWorkspaceLaunchScope
} from './runtime-legacy-worker-terminal-recovery-types'
import { getLatestPtyTitle } from './runtime-worktree-status-projection'
import type { AutomationService } from '../automations/service'
import type { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import type {
  ArtifactCloudOperation,
  ArtifactCloudOptions,
  ArtifactListItem,
  ArtifactListOptions,
  ArtifactListPage,
  ArtifactPublishResult,
  ArtifactPublishedLink,
  ArtifactWriteRequest
} from '../../shared/artifacts'

export class OrcaRuntimeWithHasExactPersistedTerminalSurfaceIdentity extends OrcaRuntimeWithFenceAutomationOwner {
  protected hasExactPersistedTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    incarnationId: string
  }): boolean {
    const session = this.getWorkspaceSessionForWorktree(expected.worktreeId)
    const sessionWorktreeId = session
      ? resolveTerminalSessionWorktreeId(session, expected.worktreeId)
      : null
    if (!session || !sessionWorktreeId) {
      return false
    }
    const tab = session.tabsByWorktree[sessionWorktreeId]?.find(
      (candidate) => candidate.id === expected.tabId
    )
    const paneKey = makePaneKey(expected.tabId, expected.leafId)
    return Boolean(
      tab &&
      session.terminalLayoutsByTabId[expected.tabId]?.ptyIdsByLeafId?.[expected.leafId] ===
        expected.ptyId &&
      session.terminalPtyIncarnationsByPaneKey?.[paneKey] === expected.incarnationId
    )
  }

  protected rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(candidate.worktreeId)
    if (snapshot) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId: candidate.ptyId,
        exactSurfaces: [{ parentTabId: candidate.tabId, leafId: candidate.leafId }],
        exactOnly: true
      })
      if (retired) {
        this.storeMobileSessionSnapshot(candidate.worktreeId, retired.snapshot)
        this.notifyMobileSessionTabsChanged(candidate.worktreeId)
      }
    }

    const leafKey = this.getLeafKey(candidate.tabId, candidate.leafId)
    const leaf = this.leaves.get(leafKey)
    const pty = this.ptysById.get(candidate.ptyId)
    if (
      leaf?.ptyId === candidate.ptyId &&
      runtimeWorktreeIdsEqual(leaf.worktreeId, candidate.worktreeId)
    ) {
      this.leaves.delete(leafKey)
      const surfaceHandle = this.handleByLeafKey.get(leafKey)
      this.handleByLeafKey.delete(leafKey)
      const handleRecord = surfaceHandle ? this.handles.get(surfaceHandle) : undefined
      if (
        surfaceHandle &&
        handleRecord?.tabId === candidate.tabId &&
        handleRecord.leafId === candidate.leafId &&
        handleRecord.ptyId === candidate.ptyId
      ) {
        this.handles.delete(surfaceHandle)
      }
      this.rebuildLeafPtyIndex()
      if (![...this.leaves.values()].some((entry) => entry.tabId === candidate.tabId)) {
        this.tabs.delete(candidate.tabId)
      }
    }
    if (pty?.tabId === candidate.tabId) {
      pty.tabId = null
      pty.paneKey = null
    }
    this.notifier?.resolveLegacyWorkerTerminalRecovery?.(
      candidate.paneKey,
      'rolled_back',
      candidate.ptyId
    )
  }

  protected getLegacyWorkerRecoveryActivation(worktreeId: string): {
    activeTabId?: string
    activeGroupId?: string
  } {
    const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    const session =
      this.store?.getWorkspaceSession?.(hostId) ?? this.getWorkspaceSessionForWorktree(worktreeId)
    const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
    return {
      ...(sessionWorktreeId && session?.activeTabIdByWorktree?.[sessionWorktreeId]
        ? { activeTabId: session.activeTabIdByWorktree[sessionWorktreeId] }
        : {}),
      ...(sessionWorktreeId && session?.activeGroupIdByWorktree?.[sessionWorktreeId]
        ? { activeGroupId: session.activeGroupIdByWorktree[sessionWorktreeId] }
        : {})
    }
  }

  protected async adoptLegacyWorkerTerminal(
    candidate: LegacyWorkerRecoveryCandidate,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: LegacyWorkerRecoveryInventory,
    activation: { activeTabId?: string; activeGroupId?: string }
  ): Promise<void> {
    await this.adoptTerminalOrphansFromInventoryUnderMutation(
      {
        worktree: `id:${candidate.worktreeId}`,
        expectedTopologyRevision: this.getTerminalTopologyRevision(candidate.worktreeId),
        ...activation,
        claims: [
          {
            terminal: candidate.terminalHandle,
            ptyId: candidate.ptyId,
            incarnationId: candidate.incarnationId,
            tabId: candidate.tabId,
            leafId: candidate.leafId
          }
        ]
      },
      workspace,
      inventory
    )
  }

  protected async revealLegacyWorkerTerminal(
    candidate: LegacyWorkerRecoveryCandidate
  ): Promise<boolean | null> {
    const pty = this.ptysById.get(candidate.ptyId)
    if (!pty || !this.notifier?.revealTerminalSession) {
      return null
    }
    const reveal = await this.notifier.revealTerminalSession(candidate.worktreeId, {
      ptyId: candidate.ptyId,
      title: getLatestPtyTitle(pty) ?? pty.controllerTitle,
      activate: false,
      presentation: 'background',
      tabId: candidate.tabId,
      leafId: candidate.leafId,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: candidate.terminalHandle,
        incarnationId: candidate.incarnationId
      }
    })
    const identity = reveal?.identity
    return Boolean(
      identity &&
      runtimeWorktreeIdsEqual(identity.worktreeId, candidate.worktreeId) &&
      identity.tabId === candidate.tabId &&
      identity.leafId === candidate.leafId &&
      identity.ptyId === candidate.ptyId
    )
  }

  setAutomationService(service: AutomationService): void {
    this.automation.setService(service)
  }

  setArtifactService(service: ArtifactCloudService): void {
    this.artifacts.setService(service)
  }

  listArtifacts(options: ArtifactListOptions): Promise<ArtifactCloudOperation<ArtifactListPage>> {
    return this.artifacts.list(options)
  }

  getPublishedArtifactLink(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<ArtifactPublishedLink | null>> {
    return this.artifacts.getPublishedLink(request)
  }

  shareArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.artifacts.share(request)
  }

  publishArtifact(
    request: ArtifactWriteRequest
  ): Promise<ArtifactCloudOperation<ArtifactPublishResult>> {
    return this.artifacts.publish(request)
  }

  updateArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.artifacts.update(request)
  }

  unshareArtifact(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<void>> {
    return this.artifacts.unshare(request)
  }

  deleteArtifact(id: string, options: ArtifactCloudOptions): Promise<ArtifactCloudOperation<void>> {
    return this.artifacts.delete(id, options)
  }
}
