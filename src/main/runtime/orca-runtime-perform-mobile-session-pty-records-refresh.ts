// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs } from './orca-runtime-build-headless-mobile-session-browser-tabs'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { TabActivationIntent } from '../../shared/tab-activation-intent'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { includeTargetResolvedWorktree } from './runtime-worktree-path-identity'
import { parseExecutionHostId } from '../../shared/execution-host'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { navigationTargetsHost } from '../../shared/runtime-navigation'
import { isAutomaticTabActivation } from '../../shared/tab-activation-intent'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'

export class OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh extends OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs {
  protected async performMobileSessionPtyRecordsRefresh(
    targetWorktreeId: string | null
  ): Promise<PtyControllerInventory | null> {
    if (!this.ptyController?.listProcesses && !this.ptyController?.hasPty) {
      return null
    }
    // Why: floating PTY identity is explicit, so polling must not resolve every Git/SSH worktree.
    const isFloatingWorkspace = targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID
    const resolvedWorktrees = isFloatingWorkspace
      ? []
      : targetWorktreeId
        ? this.listResolvedWorktreesForExplicitTarget(targetWorktreeId)
        : await this.listResolvedWorktrees()
    // An explicit mobile worktree belongs to one execution host. Query only
    // that provider; aggregate inventory would wait on unrelated SSH hosts.
    const targetExecutionHost = targetWorktreeId
      ? (resolvedWorktrees.find((worktree) => worktree.id === targetWorktreeId)?.hostId ??
        this.tryGetWorkspaceSessionHostIdForWorktree(targetWorktreeId))
      : null
    const parsedTargetHost = targetExecutionHost ? parseExecutionHostId(targetExecutionHost) : null
    // Paired/runtime-owned workspaces have a separate controller; this runtime
    // cannot inspect them and must not silently query its local PTY provider.
    if (parsedTargetHost?.kind === 'runtime') {
      return null
    }
    const targetConnectionId =
      parsedTargetHost?.kind === 'ssh'
        ? parsedTargetHost.targetId
        : targetWorktreeId
          ? null
          : undefined
    if (
      targetConnectionId !== null &&
      this.ptyController.supportsForegroundProcessEvidence &&
      !(await this.ptyController.supportsForegroundProcessEvidence(targetConnectionId))
    ) {
      // A legacy relay ignores the optional projection and would still run its
      // expensive process-table inventory on every mobile cadence tick.
      return null
    }
    return await this.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId,
      undefined,
      targetConnectionId,
      false,
      { includeForegroundProcessEvidence: false }
    )
  }

  /** Targeted mobile opens must not wait for an unrelated SSH/Git worktree scan. */
  protected listResolvedWorktreesForExplicitTarget(targetWorktreeId: string): ResolvedWorktree[] {
    const snapshot = this.resolvedWorktrees.peek()
    const cached = snapshot && snapshot.expiresAt > Date.now() ? snapshot.worktrees : null
    const targetWorktree =
      cached?.find((worktree) => worktree.id === targetWorktreeId) ??
      (() => {
        const scope = parseWorkspaceKey(targetWorktreeId)
        if (scope?.type === 'folder') {
          const folder = this.store
            ?.getFolderWorkspaces?.()
            .find((workspace) => workspace.id === scope.folderWorkspaceId)
          return folder ? this.folderWorkspaceToResolvedWorktree(folder) : null
        }
        return this.buildResolvedWorktreeFromId(targetWorktreeId)
      })()
    if (!targetWorktree) {
      return []
    }
    return cached
      ? includeTargetResolvedWorktree(cached, targetWorktree)
      : this.listKnownResolvedWorktreesForExplicitTarget(targetWorktreeId, targetWorktree)
  }

  async activateMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    leafId?: string,
    opts: {
      notifyClients?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      intent?: TabActivationIntent
    } = {}
  ): Promise<RuntimeMobileSessionTabsResult> {
    const navigation = opts.navigation ?? (opts.notifyClients === false ? 'caller' : 'all')
    const targetsHost = navigationTargetsHost(navigation)
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    await this.refreshMobileSessionPtyRecords(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const directTab = snapshot?.tabs.find((candidate) => candidate.id === tabId)
    const tab = leafId
      ? ((directTab?.type === 'terminal' && directTab.leafId === leafId ? directTab : undefined) ??
        snapshot?.tabs.find(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tabId &&
            candidate.leafId === leafId
        ))
      : (directTab ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
        ) ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
        ))
    if (!tab) {
      throw new Error('tab_not_found')
    }

    if (tab.type === 'terminal') {
      const publicTab = this.toMobileSessionTabsResult(snapshot!).tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.id === tab.id
      )
      // Why: serve-created tabs can be visible before any renderer has adopted
      // their tab id, so focusing the renderer would silently no-op.
      // Phone-local activation also needs this path for inactive restored tabs:
      // desktop focus is intentionally suppressed, but the PTY still must exist.
      const shouldMaterializePendingTerminal =
        publicTab?.type === 'terminal' &&
        publicTab.status !== 'ready' &&
        // Why: opening a tab is the documented wake gesture for a slept pane
        // (#11598), so only a background probe may be refused for one.
        (!isAutomaticTabActivation(opts.intent) ||
          !this.isDeliberatelyParkedPane(worktreeId, tab)) &&
        (!targetsHost ||
          !this.notifier?.focusTerminal ||
          this.shouldMaterializeHeadlessMobileSessionTab(snapshot!, tab))
      if (shouldMaterializePendingTerminal) {
        const sessionId = tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? undefined
        const targetGroupId = snapshot?.tabGroups?.find((group) =>
          group.tabOrder.includes(tab.parentTabId)
        )?.id
        // Why: a pending agent tab may exist without its startup command ever
        // having been delivered (the create's renderer stalled, #7587), so a
        // bare materialize would put a plain shell under the agent icon.
        // Re-resolve the launch like the create path; providers skip startup
        // commands when attaching to live sessions, so this cannot double-launch.
        let agentStartup: Awaited<
          ReturnType<OrcaRuntimeService['resolveMobileSessionTerminalCommand']>
        > = {}
        if (tab.launchAgent) {
          try {
            const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
            agentStartup = await this.resolveMobileSessionTerminalCommand(workspace, {
              agent: tab.launchAgent
            })
          } catch {
            // Why: a disabled or unresolvable agent must not make the tab
            // untappable; fall back to the plain-shell materialize.
          }
        }
        try {
          await this.createRuntimeOwnedMobileSessionTerminal(worktreeId, targetsHost, undefined, {
            identity: {
              tabId: tab.parentTabId,
              leafId: tab.leafId,
              sessionId
            },
            cwd: tab.startupCwd,
            command: agentStartup.command,
            env: agentStartup.env,
            startupCommandDelivery: agentStartup.startupCommandDelivery,
            launchConfig: agentStartup.launchConfig,
            launchAgent: tab.launchAgent,
            targetGroupId
          })
        } catch (err) {
          if (sessionId && parseAppSshPtyId(sessionId)) {
            // Why: an expired SSH reattach clears durable bindings in the store,
            // but this in-memory headless snapshot can still carry the old id.
            this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
          }
          throw err
        }
        return this.applyMobileSessionTabNavigation(
          this.getMobileSessionTabsForWorktree(worktreeId),
          tab.id,
          navigation,
          opts.clientNavigationId
        )
      }
      const callerSnapshot = this.getMobileSessionTabsForWorktree(
        worktreeId,
        opts.clientNavigationId
      )
      const activeSibling =
        tab.id === tabId || leafId
          ? null
          : (callerSnapshot.tabs.find(
              (candidate) =>
                candidate.type === 'terminal' &&
                candidate.parentTabId === tab.parentTabId &&
                candidate.isActive
            ) as RuntimeMobileSessionTerminalTab | undefined)
      const targetTab = activeSibling ?? tab
      if (targetsHost && !this.notifier?.focusTerminal) {
        if (
          !targetTab.isActive &&
          this.shouldPersistHeadlessMobileSessionActivation(snapshot!, targetTab)
        ) {
          this.activateHeadlessMobileSessionTerminalTab(worktreeId, snapshot!, targetTab)
        }
      } else if (targetsHost) {
        this.notifier?.focusTerminal?.(targetTab.parentTabId, worktreeId, targetTab.leafId)
      }
      return this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        targetTab.id,
        navigation,
        opts.clientNavigationId
      )
    } else if (tab.type === 'browser') {
      // Why: browser mobile tabs are renderer-owned unified tabs; focusing the
      // session tab keeps desktop tab order/group state authoritative.
      if (targetsHost) {
        this.notifier?.focusEditorTab?.(tab.id, worktreeId)
      }
    } else {
      if (targetsHost) {
        this.notifier?.focusEditorTab?.(tab.id, worktreeId)
      }
    }
    return this.applyMobileSessionTabNavigation(
      this.getMobileSessionTabsForWorktree(worktreeId),
      tab.id,
      navigation,
      opts.clientNavigationId
    )
  }
}
