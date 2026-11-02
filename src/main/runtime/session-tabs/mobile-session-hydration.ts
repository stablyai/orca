import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as StoredMobileSnapshotHasStalePreservedTabMethods } from './mobile-session-publication-preservation'
import type { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs as ReconcileHeadlessMobileSessionBrowserTabsMethods } from '../session-lifecycle/projection/reconcile-headless-mobile-session-browser-tabs'
import type { BrowserWindow } from 'electron'
import { OrcaRuntimeWithBuildHeadlessWorkspaceSnapshot } from './headless-workspace-snapshot'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { headlessMobileSnapshotContentUnchanged } from '../mobile-session-snapshot-equality'

export abstract class OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession extends OrcaRuntimeWithBuildHeadlessWorkspaceSnapshot {
  protected abstract isHeadlessBuiltMobileSessionPublicationBase(
    ...args: Parameters<
      StoredMobileSnapshotHasStalePreservedTabMethods['isHeadlessBuiltMobileSessionPublicationBase']
    >
  ): ReturnType<
    StoredMobileSnapshotHasStalePreservedTabMethods['isHeadlessBuiltMobileSessionPublicationBase']
  >

  protected abstract reconcileHeadlessMobileSessionBrowserTabs(
    ...args: Parameters<
      ReconcileHeadlessMobileSessionBrowserTabsMethods['reconcileHeadlessMobileSessionBrowserTabs']
    >
  ): ReturnType<
    ReconcileHeadlessMobileSessionBrowserTabsMethods['reconcileHeadlessMobileSessionBrowserTabs']
  >

  protected abstract workspaceSessionHasRuntimeOwnedPtyCandidate(
    ...args: Parameters<
      ReconcileHeadlessMobileSessionBrowserTabsMethods['workspaceSessionHasRuntimeOwnedPtyCandidate']
    >
  ): ReturnType<
    ReconcileHeadlessMobileSessionBrowserTabsMethods['workspaceSessionHasRuntimeOwnedPtyCandidate']
  >

  protected abstract workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
    ...args: Parameters<
      ReconcileHeadlessMobileSessionBrowserTabsMethods['workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate']
    >
  ): ReturnType<
    ReconcileHeadlessMobileSessionBrowserTabsMethods['workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate']
  >

  protected abstract getAvailableAuthoritativeWindow(): BrowserWindow | null

  /** A stored snapshot, or undefined when it is one this host built and left empty. */
  private readRebuildableMobileSessionSnapshot(
    worktreeId: string
  ): RuntimeMobileSessionTabsSnapshot | undefined {
    const stored = this.mobileSessionTabsByWorktree.get(worktreeId)
    // Empty headless-built snapshots cannot seed refreshes or browser-only rebuilds hide every terminal.
    return stored &&
      stored.tabs.length === 0 &&
      this.isHeadlessBuiltMobileSessionPublicationBase(stored.publicationEpoch)
      ? undefined
      : stored
  }

  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      workspaceSession?: WorkspaceSessionState
    } = {}
  ): Set<string> {
    // Report in-place reconciliations so callers avoid repeating them.
    const reconciledWorktreeIds = new Set<string>()
    const hasAuthoritativeWindow = Boolean(this.getAvailableAuthoritativeWindow())
    if (hasAuthoritativeWindow && options.allowAttachedWindow !== true) {
      return reconciledWorktreeIds
    }
    const session =
      options.workspaceSession ??
      (worktreeId
        ? this.getWorkspaceSessionForWorktree(worktreeId)
        : this.store?.getWorkspaceSession?.())
    if (!session) {
      return reconciledWorktreeIds
    }
    // Runtime-only hydration without owned terminals/offscreen backend always yields zero rows; skip per-workspace rebuilds on graph sync.
    if (
      options.onlyRuntimeOwnedTerminals === true &&
      !this.offscreenBrowserBackend &&
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId ?? '').length === 0 &&
      options.runtimeOwnedTerminalCandidateKnown !== true &&
      !(worktreeId
        ? this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
            session,
            worktreeId,
            session.tabsByWorktree[worktreeId] ?? []
          )
        : this.workspaceSessionHasRuntimeOwnedPtyCandidate(session))
    ) {
      return reconciledWorktreeIds
    }
    // A worktree whose only tabs are editors has no tabsByWorktree key.
    const entries =
      worktreeId !== undefined
        ? ([[worktreeId, session.tabsByWorktree[worktreeId] ?? []]] as const)
        : [
            ...new Set([
              ...Object.keys(session.tabsByWorktree ?? {}),
              ...Object.keys(session.openFilesByWorktree ?? {})
            ])
          ].map((id) => [id, session.tabsByWorktree?.[id] ?? []] as const)
    // Skip removed-repo session keys to avoid phantom workspaces; resolve inventory lazily for parseable keys and preserve unknown inventory as unavailable.
    let liveRepoIds: Set<string> | null | undefined
    for (const [entryWorktreeId, persistedTabs] of entries) {
      const ownerRepoId = splitWorktreeIdForFilesystem(entryWorktreeId)?.repoId
      if (ownerRepoId) {
        if (liveRepoIds === undefined) {
          const knownRepos = this.store?.getRepos?.()
          liveRepoIds = knownRepos ? new Set(knownRepos.map((repo) => repo.id)) : null
        }
        if (liveRepoIds && !liveRepoIds.has(ownerRepoId)) {
          continue
        }
      }
      const stored = this.readRebuildableMobileSessionSnapshot(entryWorktreeId)
      if (
        stored &&
        stored.tabs.length > 0 &&
        options.force !== true &&
        options.onlyRuntimeOwnedTerminals !== true
      ) {
        // Terminal rows are stable; refresh only live browser rows to capture creates/closes without rebuilding terminals.
        this.reconcileHeadlessMobileSessionBrowserTabs(entryWorktreeId, stored)
        reconciledWorktreeIds.add(entryWorktreeId)
        // Rebuild immediately after the last browser closes instead of serving one empty browser-only snapshot.
        if (this.readRebuildableMobileSessionSnapshot(entryWorktreeId)) {
          continue
        }
      }
      const existing = this.readRebuildableMobileSessionSnapshot(entryWorktreeId)
      // Windowless hosts have no other row publisher; a filtered seed would suppress the full rebuild.
      const runtimeOwnedOnly =
        options.onlyRuntimeOwnedTerminals === true &&
        (existing !== undefined || hasAuthoritativeWindow)
      const built = this.buildHeadlessWorkspaceSnapshot(
        entryWorktreeId,
        persistedTabs,
        session,
        existing,
        { onlyRuntimeOwnedTerminals: options.onlyRuntimeOwnedTerminals === true, runtimeOwnedOnly }
      )
      if (!built) {
        continue
      }
      const nextSnapshot = built
      // Retain the existing object and version for equal projections so unchanged graph syncs do not fan out.
      if (existing && headlessMobileSnapshotContentUnchanged(existing, nextSnapshot)) {
        continue
      }
      this.storeMobileSessionSnapshot(entryWorktreeId, nextSnapshot)
    }
    return reconciledWorktreeIds
  }
}
