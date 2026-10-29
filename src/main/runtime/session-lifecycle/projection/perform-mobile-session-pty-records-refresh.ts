import type { RuntimeWorkspaceSelectors as WorkspaceSelectors } from '../../workspaces/workspace-selectors'
import type { OrcaRuntimeWithApplyMobileSessionTabNavigation as MobileSessionNavigation } from './apply-mobile-session-tab-navigation'
import type { OrcaRuntimeWithAgentSessionResumeOwnership as AgentSessionResume } from './agent-session-resume-ownership'
import type { OrcaRuntimeWithStopTerminalsForWorktree as WorktreeTerminalStop } from '../../terminal/stop/worktree-terminal-stop'
import { OrcaRuntimeWithRestoredPaneStart } from './restored-pane-materialize'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { PtyControllerInventory } from '../../runtime-pty-controller-contract'
import { isAgentLaunchRunningIn } from '../../../agent-launch/agent-launch-pane-attachment'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import type { TabActivationIntent } from '../../../../shared/tab-activation-intent'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RuntimeMobileSessionTabActivationResult } from '../../../../shared/runtime-session-contracts'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { includeTargetResolvedWorktree } from '../../runtime-worktree-path-identity'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { navigationTargetsHost } from '../../../../shared/runtime-navigation'
import { isAutomaticTabActivation } from '../../../../shared/tab-activation-intent'
import { isWorktreeTerminalsSleepingError } from '../../worktree-terminals-sleeping-error'

import { paneHoldsSession } from '../../terminal/surface/main-terminal-surfaces'
export abstract class OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh extends OrcaRuntimeWithRestoredPaneStart {
  protected abstract buildResolvedWorktreeFromId(
    ...args: Parameters<WorkspaceSelectors['buildResolvedWorktreeFromId']>
  ): ReturnType<WorkspaceSelectors['buildResolvedWorktreeFromId']>
  protected abstract isDeliberatelyParkedPane(
    ...args: Parameters<AgentSessionResume['isDeliberatelyParkedPane']>
  ): ReturnType<AgentSessionResume['isDeliberatelyParkedPane']>
  protected abstract isWorktreeTerminalSleepHeld(
    ...args: Parameters<WorktreeTerminalStop['isWorktreeTerminalSleepHeld']>
  ): ReturnType<WorktreeTerminalStop['isWorktreeTerminalSleepHeld']>
  protected abstract shouldMaterializeHeadlessMobileSessionTab(
    ...args: Parameters<MobileSessionNavigation['shouldMaterializeHeadlessMobileSessionTab']>
  ): ReturnType<MobileSessionNavigation['shouldMaterializeHeadlessMobileSessionTab']>
  protected abstract applyMobileSessionTabNavigation(
    ...args: Parameters<MobileSessionNavigation['applyMobileSessionTabNavigation']>
  ): ReturnType<MobileSessionNavigation['applyMobileSessionTabNavigation']>
  protected abstract shouldPersistHeadlessMobileSessionActivation(
    ...args: Parameters<MobileSessionNavigation['shouldPersistHeadlessMobileSessionActivation']>
  ): ReturnType<MobileSessionNavigation['shouldPersistHeadlessMobileSessionActivation']>
  protected abstract activateHeadlessMobileSessionTerminalTab(
    ...args: Parameters<MobileSessionNavigation['activateHeadlessMobileSessionTerminalTab']>
  ): ReturnType<MobileSessionNavigation['activateHeadlessMobileSessionTerminalTab']>

  protected async performMobileSessionPtyRecordsRefresh(
    targetWorktreeId: string | null
  ): Promise<PtyControllerInventory | null> {
    if (!this.ptyController?.listProcesses && !this.ptyController?.hasPty) {
      return null
    }
    // Floating PTYs need no Git/SSH workspace resolution.
    const isFloatingWorkspace = targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID
    const resolvedWorktrees = isFloatingWorkspace
      ? []
      : targetWorktreeId
        ? this.listResolvedWorktreesForExplicitTarget(targetWorktreeId)
        : await this.listResolvedWorktrees()
    // Query only the target's execution host; aggregate inventory can block behind unrelated SSH hosts.
    const targetExecutionHost = targetWorktreeId
      ? (resolvedWorktrees.find((worktree) => worktree.id === targetWorktreeId)?.hostId ??
        this.tryGetWorkspaceSessionHostIdForWorktree(targetWorktreeId))
      : null
    const parsedTargetHost = targetExecutionHost ? parseExecutionHostId(targetExecutionHost) : null
    // Paired runtime workspaces have another controller; never substitute this machine's PTY provider.
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
      !(await this.ptyController.supportsForegroundProcessEvidence(
        parsedTargetHost?.kind === 'ssh' ? parsedTargetHost.id : undefined
      ))
    ) {
      // Legacy relays ignore projection hints and would rescan the expensive process table on every mobile tick.
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
  ): Promise<RuntimeMobileSessionTabActivationResult> {
    const navigation = opts.navigation ?? (opts.notifyClients === false ? 'caller' : 'all')
    const targetsHost = navigationTargetsHost(navigation)
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    let worktreeId =
      explicitWorktreeId ?? (await this.resolveWorkspaceSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    await this.refreshMobileSessionPtyRecords(worktreeId)
    // Why: the renderer can publish the host's spelling while inventory refresh is pending.
    worktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ?? worktreeId
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
      // Serve-created/restored tabs may lack renderer adoption; materialize locally even when phone-only navigation suppresses desktop focus.
      const automatic = isAutomaticTabActivation(opts.intent)
      const shouldMaterializePendingTerminal =
        publicTab?.type === 'terminal' &&
        publicTab.status !== 'ready' &&
        // Explicit tab opens wake slept panes (#11598); refuse only automatic probes.
        (!automatic ||
          (!this.isDeliberatelyParkedPane(worktreeId, tab) &&
            !this.isWorktreeTerminalSleepHeld(worktreeId))) &&
        // An early launch tab must wait for its launch's own spawn.
        !isAgentLaunchRunningIn(worktreeId, {
          kind: 'pane',
          tabId: tab.parentTabId,
          leafId: tab.leafId
        }) &&
        (!targetsHost ||
          !this.notifier?.focusTerminal ||
          this.shouldMaterializeHeadlessMobileSessionTab(snapshot!, tab))
      if (shouldMaterializePendingTerminal) {
        const targetGroupId = snapshot?.tabGroups?.find((group) =>
          group.tabOrder.includes(tab.parentTabId)
        )?.id
        const trigger = { automatic, targetsHost, targetGroupId }
        let startupCwdFallback: RuntimeMobileSessionTabActivationResult['startupCwdFallback']
        try {
          if (ORCA_LAYOUT_OWNER_IS_MAIN) {
            const started = await this.ensureRestoredPaneStarted(
              { worktreeId, tabId: tab.parentTabId, leafId: tab.leafId },
              trigger
            )
            if (started === null) {
              throw new Error('tab_not_found')
            }
            startupCwdFallback = started.startupCwdFallback
          } else {
            await this.materializePendingMobileSessionTerminal(worktreeId, tab, {
              ...trigger,
              sessionId: tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? undefined
            }).then((created) => (startupCwdFallback = created.startupCwdFallback))
          }
        } catch (err) {
          if (automatic && isWorktreeTerminalsSleepingError(err)) {
            // The host may sleep this worktree while the probe waits for its spawn lock.
            return this.applyMobileSessionTabNavigation(
              this.getMobileSessionTabsForWorktree(worktreeId),
              tab.id,
              navigation,
              opts.clientNavigationId
            )
          }
          throw err
        }
        const activated = this.applyMobileSessionTabNavigation(
          this.getMobileSessionTabsForWorktree(worktreeId),
          tab.id,
          navigation,
          opts.clientNavigationId
        )
        return startupCwdFallback ? { ...activated, startupCwdFallback } : activated
      }
      const callerSnapshot = this.getMobileSessionTabsForWorktree(
        worktreeId,
        opts.clientNavigationId
      )
      const activeSibling =
        tab.id === tabId || leafId
          ? null
          : callerSnapshot.tabs.find(
              (
                candidate
              ): candidate is Extract<
                RuntimeMobileSessionTabsResult['tabs'][number],
                { type: 'terminal' }
              > =>
                candidate.type === 'terminal' &&
                candidate.parentTabId === tab.parentTabId &&
                candidate.isActive
            )
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
      if (tab.browserPageId) {
        await this.serveBrowserTabs.start(worktreeId, tab.browserPageId)
      }
      // Browser rows are renderer-owned; session-tab focus preserves desktop order/group authority.
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

  /** Whether a pane may still hold an agent session: a terminal of it not proven exited, or none. */
  protected paneHoldsSession(paneKey: string): boolean {
    const panePtyIds = [...this.ptysById.values()].flatMap((pty) =>
      this.paneOfPty(pty).paneKey === paneKey ? [pty.ptyId] : []
    )
    return paneHoldsSession(this, paneKey, panePtyIds, (ptyId) => this.isPtyKnownExited(ptyId))
  }
}
