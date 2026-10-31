import {
  recordPtySurface,
  spawnSurfaceClaimSequence,
  SURFACE_CLAIM_WITHOUT_STANDING
} from '../../pty-recorded-surface-topology'
import { resolveStructuredWorkerAuthority } from '../../structured-worker-authority'
import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithSubscribeToTerminalResize } from '../layout/terminal-resize-listeners'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../../../shared/runtime-types'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { PtyControllerInventory } from '../../runtime-pty-controller-contract'
import { resolveTerminalSessionWorktreeId } from '../../runtime-worktree-path-identity'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { adoptRuntimeTerminalOrphansFromInventory } from '../../runtime-terminal-orphan-adoption'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { getLatestPtyTitle } from '../../runtime-worktree-status-projection'
import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'

export abstract class OrcaRuntimeWithAdoptTerminalOrphansFromInventory extends OrcaRuntimeWithSubscribeToTerminalResize {
  protected abstract issueHandle(leaf: RuntimeLeafRecord): string

  protected abstract getPaneKeyForTerminalHandle(handle: string): string | null

  abstract assertGraphReady(): void

  protected async adoptTerminalOrphansFromInventoryUnderMutation(
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    const store = this.store
    if (!store?.setWorkspaceSession || (!store.flushPendingOrThrowAsync && !store.flushOrThrow)) {
      throw new Error('workspace_session_unavailable')
    }
    const readSession = () => {
      const session = this.getWorkspaceSessionForWorktree(workspace.id)
      if (!session) {
        throw new Error('workspace_session_unavailable')
      }
      const sessionWorktreeId = resolveTerminalSessionWorktreeId(session, workspace.id)
      if (!sessionWorktreeId) {
        throw new Error('terminal_orphan_competing_owner')
      }
      return {
        session,
        sessionWorktreeId,
        currentRevision: this.getTerminalTopologyRevision(workspace.id)
      }
    }
    readSession()
    const runDurableMutation = store.runDurableMutation?.bind(store)
    const worktreeConnectionId = workspace.connectionId
    let worktreeWslDistro: string | null = null
    if (!worktreeConnectionId && workspace.repo) {
      try {
        worktreeWslDistro =
          getLocalProjectWorktreeGitOptions(this.requireStore(), workspace.repo).wslDistro ?? null
      } catch {
        throw new Error('terminal_orphan_owner_mismatch')
      }
    }
    return adoptRuntimeTerminalOrphansFromInventory({
      hostId: this.workspaceSessions.getHostId(workspace.id),
      request,
      workspace,
      inventory,
      repoId: getRepoIdFromWorktreeId(workspace.id),
      worktreeWslDistro,
      ports: {
        readSession,
        getPty: (handle) => this.getLivePtyForHandle(handle)?.pty ?? null,
        paneOf: (pty) => this.paneOfPty(pty),
        getLeaves: (ptyId) => this.getLeavesForPty(ptyId),
        getLeaf: (tabId, leafId) => this.leaves.get(this.getLeafKey(tabId, leafId)),
        getDisplayTitle: (pty) => getLatestPtyTitle(this.getPtyDisplayRecord(pty)),
        replayPersistedSurface: (pty, tabId, paneKey) =>
          recordPtySurface(pty, tabId, paneKey, SURFACE_CLAIM_WITHOUT_STANDING),
        recordAdoptedSurface: (pty, tabId, paneKey) => {
          recordPtySurface(pty, tabId, paneKey, spawnSurfaceClaimSequence(this.graphSequence))
          this.followExportedPaneKeys()
        },
        getMobileSnapshots: () => this.mobileSessionTabsByWorktree.values(),
        getSession: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
        setSession: (worktreeId, next) => this.setWorkspaceSessionForWorktree(worktreeId, next),
        ...(runDurableMutation ? { runDurableMutation } : {}),
        flushSession: () => this.flushWorkspaceSessionOrThrowAsync(),
        hydrateSession: (worktreeId) =>
          this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
            force: true,
            allowAttachedWindow: true,
            onlyRuntimeOwnedTerminals: true
          }),
        notifySessionChanged: (worktreeId) => this.notifyMobileSessionTabsChanged(worktreeId),
        getSnapshot: (worktreeId) => this.getTerminalOrphanAdoptionSnapshot(worktreeId)
      }
    })
  }

  protected getTerminalOrphanAdoptionSnapshot(worktreeId: string): RuntimeMobileSessionTabsResult {
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    return this.getMobileSessionTabsForWorktree(worktreeId)
  }

  // Omitted --terminal follows the current worktree's active terminal, like browser active-tab resolution.
  async resolveActiveTerminal(
    worktreeSelector?: string,
    options: { requireUnambiguous?: boolean } = {}
  ): Promise<string> {
    if (this.graphStatus !== 'ready') {
      const targetWorktreeId = worktreeSelector
        ? (await this.resolveWorkspaceSelector(worktreeSelector)).id
        : null
      const snapshots = targetWorktreeId
        ? [this.getMobileSessionTabsForWorktree(targetWorktreeId)]
        : await this.listAllMobileSessionTabs()
      // Active-tab focus cannot establish the caller's identity.
      for (const snapshot of options.requireUnambiguous ? [] : snapshots) {
        const activeTerminal = snapshot.tabs.find(
          (tab) =>
            tab.type === 'terminal' &&
            tab.isActive &&
            tab.status === 'ready' &&
            typeof tab.terminal === 'string'
        )
        if (activeTerminal?.type === 'terminal' && activeTerminal.terminal) {
          return activeTerminal.terminal
        }
      }
      const listed = await this.listTerminals(worktreeSelector, undefined, {
        includeVisualLayouts: false
      })
      // Multiple terminals make any identity claim an arbitrary guess.
      if (options.requireUnambiguous && listed.terminals.length > 1) {
        throw new Error('no_active_terminal')
      }
      const first = listed.terminals[0]?.handle
      if (first) {
        return first
      }
      throw new Error('no_active_terminal')
    }
    this.assertGraphReady()

    const targetWorktreeId = worktreeSelector
      ? (await this.resolveWorkspaceSelector(worktreeSelector)).id
      : null

    // Prefer last-focused panes only outside identity claims.
    for (const tab of options.requireUnambiguous ? [] : this.tabs.values()) {
      if (targetWorktreeId && tab.worktreeId !== targetWorktreeId) {
        continue
      }
      if (!tab.activeLeafId) {
        continue
      }
      const leafKey = this.getLeafKey(tab.tabId, tab.activeLeafId)
      const leaf = this.leaves.get(leafKey)
      if (leaf) {
        return this.issueHandle(leaf)
      }
    }

    // An arbitrary identity guess can attribute worker_done to a sibling and settle its tokenless dispatch.
    // Worker children carry ORCA_TERMINAL_HANDLE; ordinary structured chats instead use ORCA_STRUCTURED_SESSION so the CLI refuses guesses even with one pane.
    const candidates: RuntimeLeafRecord[] = []
    for (const leaf of this.leaves.values()) {
      if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
        continue
      }
      if (!options.requireUnambiguous) {
        return this.issueHandle(leaf)
      }
      candidates.push(leaf)
      if (candidates.length > 1) {
        break
      }
    }
    if (candidates.length === 1) {
      return this.issueHandle(candidates[0]!)
    }

    throw new Error('no_active_terminal')
  }

  // Dispatch uses remint-stable pane keys; unresolved handles return null so best-effort dispatch can proceed.
  getTerminalPaneKey(handle: string): string | null {
    return (
      resolveStructuredWorkerAuthority(handle, this.getOrchestrationDbIfAvailable?.() ?? null)
        ?.identity.paneKey ??
      this.getPaneKeyForTerminalHandle(handle) ??
      this.getOrchestrationCompatibilitySshTerminal(handle)?.paneKey ??
      null
    )
  }

  getLiveTerminalPaneKey(handle: string): string | null {
    const structured = resolveStructuredWorkerAuthority(
      handle,
      this.getOrchestrationDbIfAvailable?.() ?? null
    )
    if (structured) {
      // Runtime-owned structured workers accept direct mail even at rest; sending starts their agent.
      return structured.identity.paneKey
    }
    const runtimePty = this.getLivePtyForHandle(handle)
    if (runtimePty) {
      return runtimePty.pty.connected ? this.paneOfPty(runtimePty.pty).paneKey : null
    }
    try {
      const leaf = this.resolveLiveLeafForHandle(handle)
      if (!leaf?.ptyId) {
        return this.getOrchestrationCompatibilitySshTerminal(handle)?.paneKey ?? null
      }
      const pty = this.ptysById.get(leaf.ptyId)
      return pty?.connected === false ? null : this.getPaneKeyForTerminalHandle(handle)
    } catch {
      return null
    }
  }

  // Retained handles keep earned death certificates readable after liveness-gated lookups become stale.
  getTerminalLivenessVerdict(handle: string): PtyLivenessVerdict | null {
    const record = this.getLivePtyForHandle(handle)?.record ?? this.handles.get(handle)
    return record?.ptyId ? this.getPtyLivenessVerdict(record.ptyId) : null
  }

  /** The hook store's verdict on the agent in this terminal, keeping exits proven since `exitedSince`. */
  checkTerminalAgentPresence(
    handle: string,
    exitedSince: number
  ): Promise<'live' | 'unverifiable' | 'exited' | null> {
    const ptyId = (this.getLivePtyForHandle(handle)?.record ?? this.handles.get(handle))?.ptyId
    return ptyId ? this.recheckHookAgentPresenceForPty(ptyId, exitedSince) : Promise.resolve(null)
  }

  /** A worker now owns this terminal; drop any agent exit the hook store proved before it. */
  forgetTerminalAgentExit(handle: string): void {
    const ptyId = (this.getLivePtyForHandle(handle)?.record ?? this.handles.get(handle))?.ptyId
    if (ptyId) {
      this.forgetHookAgentExitFn?.(this.collectAgentStatusPaneKeysForPty(ptyId))
    }
  }
}
