import { placeCreatedSessionTab } from '../../../../shared/session-tab-placement'
import { insertTabIdIntoOrder } from '../../../../shared/workspace-layout/tab-order'
import { OrcaRuntimeWithReconcileOwnedMobileTerminal } from './mobile-terminal-create-reconciliation'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import {
  pruneOwnedMobileTerminalDispatchRecipes,
  recordOwnedMobileTerminalDispatchRecipe,
  type OwnedMobileTerminalCreateOptions,
  type OwnedMobileTerminalDispatchRecipe
} from './mobile-terminal-create'
import { randomUUID } from 'node:crypto'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../../remote-runtime-terminal-create-identity'
import type { OrcaRuntimeWithBuildPtyTerminalSummary as PtyTerminalSummaryMethods } from '../query/pty-terminal-summary'
import {
  buildHeadlessMobileSessionTabGroups,
  buildMaterializedHeadlessParentLayout,
  getHeadlessMobileSessionGroupId
} from '../../mobile-session-layout-projection'

export type { OwnedMobileTerminalCreateOptions } from './mobile-terminal-create'

export abstract class OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal extends OrcaRuntimeWithReconcileOwnedMobileTerminal {
  protected abstract getPtyManualTitle(
    ...args: Parameters<PtyTerminalSummaryMethods['getPtyManualTitle']>
  ): ReturnType<PtyTerminalSummaryMethods['getPtyManualTitle']>

  private readonly ownedMobileDispatchRecipes = new Map<string, OwnedMobileTerminalDispatchRecipe>()

  protected async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: OwnedMobileTerminalCreateOptions = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    pruneOwnedMobileTerminalDispatchRecipes(this.ownedMobileDispatchRecipes)
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(
      `id:${worktreeId}`,
      undefined,
      {
        wslUserAct: opts.wslUserAct === true
      }
    )
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Why: an SSH sessionId means reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
    const stableSessionId =
      opts.identity?.sessionId ?? (workspace.connectionId ? undefined : `serve-${randomUUID()}`)
    const isNewSession = stableSessionId !== undefined && opts.identity?.sessionId === undefined
    const mutationHandle = opts.createMutation
      ? deriveRemoteRuntimeTerminalCreateHandle(
          opts.createMutation.clientIdentity,
          worktreeId,
          opts.createMutation.id
        )
      : undefined
    const create = (preAllocatedHandle?: string) =>
      this.createTerminal(`id:${worktreeId}`, {
        focus: false,
        ...(opts.presentation ? { presentation: opts.presentation } : {}),
        ...(opts.afterDesktopTabId ? { afterTabId: opts.afterDesktopTabId } : {}),
        onPtySpawnDispatched: (launch) => {
          if (mutationHandle && launch) {
            recordOwnedMobileTerminalDispatchRecipe(
              this.ownedMobileDispatchRecipes,
              mutationHandle,
              launch,
              workspace
            )
          }
          // Why after the recipe: its refusal above is still before dispatch.
          opts.onPtySpawnDispatched?.()
        },
        ...(preAllocatedHandle ? { preAllocatedHandle } : {}),
        command: opts.command,
        ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
        cwd,
        env: opts.env,
        envToDelete: opts.envToDelete,
        ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
        ...(opts.resumeProviderSession
          ? { resumeProviderSession: opts.resumeProviderSession }
          : {}),
        ...(opts.spawnIntent ? { spawnIntent: opts.spawnIntent } : {}),
        ...(opts.wslUserAct ? { wslUserAct: true } : {}),
        ...(opts.resumeOrigin ? { resumeOrigin: opts.resumeOrigin } : {}),
        ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
        ...(opts.launchRuntime ? { launchRuntime: opts.launchRuntime } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
        ...(opts.targetGroupId ? { targetGroupId: opts.targetGroupId } : {}),
        startupCommandDelivery: opts.startupCommandDelivery,
        ...(opts.identity
          ? {
              tabId: opts.identity.tabId,
              leafId: opts.identity.leafId,
              ...(stableSessionId ? { sessionId: stableSessionId } : {})
            }
          : stableSessionId
            ? { sessionId: stableSessionId }
            : {}),
        ...(isNewSession ? { isNewSession: true } : {}),
        persistHostSessionBinding: true,
        // Publish only the authoritative snapshot below to avoid a temporary wrong-group placement.
        deferMobileSessionPublish: true,
        signal: opts.signal,
        ...(opts.refuseSleptWorktree ? { refuseSleptWorktree: true } : {}),
        ...(opts.resumesSleepingRecord ? { resumesSleepingRecord: true } : {})
      })
    const terminal = opts.createMutation
      ? await this.dedupeTerminalCreate(
          opts.createMutation.clientIdentity,
          `id:${worktreeId}`,
          opts.createMutation.id,
          true,
          (_selector, handle) => create(handle),
          { wslUserAct: opts.wslUserAct === true }
        )
      : await create()
    if (terminal.ptyId) {
      opts.onPtyCreated?.(terminal.ptyId, terminal)
    }
    const livePty = this.getLivePtyForHandle(terminal.handle)
    if (!livePty) {
      throw new Error('terminal_handle_stale')
    }
    const dispatched =
      mutationHandle === terminal.handle
        ? this.ownedMobileDispatchRecipes.get(terminal.handle)
        : undefined
    const recipe = opts.createMutation
      ? this.validateOwnedMobileDispatch(
          livePty.pty,
          terminal,
          opts,
          dispatched,
          workspace.connectionId ?? null
        )
      : undefined
    const { tabId: parentTabId, leafId } = await this.reconcileOwnedMobileTerminalSurface(
      worktreeId,
      workspace.connectionId ?? null,
      terminal,
      livePty.pty,
      recipe
    )
    if (opts.createMutation) {
      livePty.pty.runtimeSessionOwned = true
    }
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const existingSurface =
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === parentTabId &&
          candidate.leafId === leafId
      ) ?? null
    const parentLayout = buildMaterializedHeadlessParentLayout(
      leafId,
      livePty.pty.ptyId,
      existingSurface?.parentLayout
    )
    // A terminal restarted for a saved tab keeps the tab's saved name; a row's null stays cleared.
    const customTitle =
      existingSurface?.customTitle !== undefined
        ? existingSurface.customTitle
        : this.getPtyManualTitle(livePty.pty, false) || undefined
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      ptyId: livePty.pty.ptyId,
      incarnationId: livePty.pty.incarnationId,
      title: terminal.title ?? livePty.pty.title ?? 'Terminal',
      ...(customTitle !== undefined ? { customTitle } : {}),
      // Omit only a proven root correction; an unverifiable fallback keeps its saved request.
      ...((terminal.savedStartupCwd ?? cwd) && (terminal.savedStartupCwd ?? cwd) !== workspace.path
        ? { startupCwd: terminal.savedStartupCwd ?? cwd }
        : {}),
      ...(livePty.pty.launchAgent ? { launchAgent: livePty.pty.launchAgent } : {}),
      ...(!terminal.agentResumeRefused && !terminal.agentResumeUnavailable && opts.viewMode
        ? { viewMode: opts.viewMode }
        : {}),
      parentLayout,
      isActive: activate
    }
    const tabs = placeCreatedSessionTab(
      (existing?.tabs ?? []).map((candidate) => ({
        ...candidate,
        ...(candidate.type === 'terminal' && candidate.parentTabId === parentTabId
          ? { parentLayout }
          : {}),
        isActive: activate ? false : candidate.isActive
      })),
      tab,
      afterTabId,
      { afterParentGroup: opts.supportsSplitGroupPlacement !== false }
    )
    const tabGroups = buildHeadlessMobileSessionTabGroups(
      worktreeId,
      tabs,
      activate ? tab : null,
      existing?.tabGroups,
      opts.targetGroupId ? { tabId: parentTabId, groupId: opts.targetGroupId } : undefined
    )
    if (opts.afterDesktopTabId) {
      const group = tabGroups.find((candidate) => candidate.tabOrder.includes(parentTabId))
      if (group?.tabOrder.includes(opts.afterDesktopTabId)) {
        const topLevelTabs = tabs.map((candidate) => ({
          id: candidate.type === 'terminal' ? candidate.parentTabId : candidate.id,
          isPinned: candidate.isPinned === true
        }))
        group.tabOrder = insertTabIdIntoOrder(
          group.tabOrder,
          topLevelTabs,
          parentTabId,
          tab.isPinned === true,
          opts.afterDesktopTabId
        )
      }
    }
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      // New epochs retire the prior publisher and reject its later updates.
      publicationEpoch: existing?.publicationEpoch ?? `headless:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      // Activating the new tab must also focus its requested split group.
      activeGroupId:
        activate && opts.targetGroupId
          ? opts.targetGroupId
          : (existing?.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId)),
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabGroups,
      // Retain split geometry when adding a tab.
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    // Store adds retirement proofs; emit that snapshot because version-deduping subscribers would miss proofs from a pre-store frame.
    const stored = this.storeMobileSessionSnapshot(worktreeId, next)
    const result = this.toMobileSessionTabsResult(stored)
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
    const created = result.tabs.find((candidate) => candidate.id === tab.id)
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    if (recipe && this.ownedMobileDispatchRecipes.get(terminal.handle) === recipe) {
      this.ownedMobileDispatchRecipes.delete(terminal.handle)
    }
    return {
      tab: created,
      ...(terminal.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {}),
      ...(terminal.agentResumeRefused ? { agentResumeRefused: true as const } : {}),
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion,
      ...(terminal.startupCwdFallback ? { startupCwdFallback: 'workspace-root' as const } : {})
    }
  }
}
