// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import {
  observeStructuredWorker,
  resolveStructuredWorkerAuthority
} from './structured-worker-authority'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import { OrcaRuntimeWithSubscribeToTerminalResize } from './orca-runtime-subscribe-to-terminal-resize'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../shared/runtime-types'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { resolveTerminalSessionWorktreeId } from './runtime-worktree-path-identity'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { adoptRuntimeTerminalOrphansFromInventory } from './runtime-terminal-orphan-adoption'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'

export class OrcaRuntimeWithAdoptTerminalOrphansFromInventory extends OrcaRuntimeWithSubscribeToTerminalResize {
  protected async adoptTerminalOrphansFromInventoryUnderMutation(
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    const store = this.store
    const session = this.getWorkspaceSessionForWorktree(workspace.id)
    if (
      !store?.setWorkspaceSession ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow) ||
      !session
    ) {
      throw new Error('workspace_session_unavailable')
    }
    const sessionWorktreeId = resolveTerminalSessionWorktreeId(session, workspace.id)
    if (!sessionWorktreeId) {
      throw new Error('terminal_orphan_competing_owner')
    }
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
      request,
      workspace,
      inventory,
      session,
      sessionWorktreeId,
      repoId: getRepoIdFromWorktreeId(workspace.id),
      worktreeWslDistro,
      currentRevision: this.getTerminalTopologyRevision(workspace.id),
      ports: {
        getPty: (handle) => this.getLivePtyForHandle(handle)?.pty ?? null,
        getLeaves: (ptyId) => this.getLeavesForPty(ptyId),
        getLeaf: (tabId, leafId) => this.leaves.get(this.getLeafKey(tabId, leafId)),
        getMobileSnapshots: () => this.mobileSessionTabsByWorktree.values(),
        getSession: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
        setSession: (worktreeId, next) => this.setWorkspaceSessionForWorktree(worktreeId, next),
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

  // Why: when --terminal is omitted, the CLI auto-resolves to the active
  // terminal in the current worktree — matching browser's implicit active tab.
  async resolveActiveTerminal(
    worktreeSelector?: string,
    options: { requireUnambiguous?: boolean } = {}
  ): Promise<string> {
    if (this.graphStatus !== 'ready') {
      const targetWorktreeId = worktreeSelector
        ? (await this.resolveWorktreeSelector(worktreeSelector)).id
        : null
      const snapshots = targetWorktreeId
        ? [this.getMobileSessionTabsForWorktree(targetWorktreeId)]
        : await this.listAllMobileSessionTabs()
      // Skipped for an identity claim for the same reason as the ready path below: the active tab
      // is where the user last looked, which says nothing about which terminal the CALLER is.
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
      // Same arbitrary pick, same misattribution: refuse for callers claiming their own identity.
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
      ? (await this.resolveWorktreeSelector(worktreeSelector)).id
      : null

    // Prefer the tab's activeLeafId — this is the pane the user last focused.
    //
    // Skipped entirely for an identity claim: which pane the user last looked at says nothing
    // about which terminal the CALLER is, so preferring it is still a guess.
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

    // Fallback: any leaf in the target worktree.
    //
    // `requireUnambiguous` callers are asking "which terminal AM I" — today the implicit `--from`
    // sender — and an arbitrary iteration-order pick answers that with someone else's pane: a bare
    // `send --type worker_done` then settles a SIBLING's context-only dispatch, a tier that has no
    // capability token to reject on, and every message it sends is attributed to that sibling.
    // Refusing is the only safe answer when more than one leaf could be meant.
    //
    // `check` resolves through the `--terminal` scope, which still guesses, and a DISPATCHED
    // structured worker is covered by the `ORCA_TERMINAL_HANDLE` its child is spawned with. That
    // was once written as covering structured sessions generally, and it never did: an ordinary
    // structured chat session is not in the worker registry, so it is spawned with no handle at
    // all, and the guess below handed it a sibling's pane — which a destructive `check` then
    // consumed. `requireUnambiguous` does not save it either, because with exactly one terminal
    // pane the guess resolves. Such a child now carries `ORCA_STRUCTURED_SESSION` and the CLI
    // refuses before reaching here (`shared/structured-session-marker.ts`).
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

  // Why: orchestration records the pane key as the remint-stable assignee
  // identity at dispatch time; null (best-effort) rather than throwing so
  // dispatch still works for handles without a resolvable pane.
  getTerminalPaneKey(handle: string): string | null {
    return (
      resolveStructuredWorkerAuthority(handle, this.getOrchestrationDbIfAvailable?.() ?? null)
        ?.identity.paneKey ?? this.getPaneKeyForTerminalHandle(handle)
    )
  }

  getLiveTerminalPaneKey(handle: string): string | null {
    const structured = resolveStructuredWorkerAuthority(
      handle,
      this.getOrchestrationDbIfAvailable?.() ?? null
    )
    if (structured) {
      // `resolveBareOrchestrationRecipient` routes direct mail through this, not through
      // getTerminalPaneKey. The connected-gate below exists so mail is never routed to a corpse,
      // so the structured answer needs a real liveness proof too, not just a registry hit.
      return observeStructuredWorker(structured.identity).status === 'live'
        ? structured.identity.paneKey
        : null
    }
    const runtimePty = this.getLivePtyForHandle(handle)
    if (runtimePty) {
      return runtimePty.pty.connected ? (runtimePty.pty.paneKey ?? null) : null
    }
    try {
      const leaf = this.resolveLiveLeafForHandle(handle)
      if (!leaf?.ptyId) {
        return null
      }
      const pty = this.ptysById.get(leaf.ptyId)
      return pty?.connected === false ? null : this.getPaneKeyForTerminalHandle(handle)
    } catch {
      return null
    }
  }

  // Resolve through the retained handle record, not the liveness-gated agent-status lookup: that
  // one throws `terminal_handle_stale` once the process is gone, which is exactly when the earned
  // death certificate has to stay readable.
  getTerminalLivenessVerdict(handle: string): PtyLivenessVerdict | null {
    const record = this.getLivePtyForHandle(handle)?.record ?? this.handles.get(handle)
    return record?.ptyId ? this.getPtyLivenessVerdict(record.ptyId) : null
  }
}
