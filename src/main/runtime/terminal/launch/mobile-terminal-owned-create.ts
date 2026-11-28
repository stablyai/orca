import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as SessionTabsPublication } from '../../session-tabs/publication/session-tabs-change-publication'
import { OrcaRuntimeWithResolveMobileSessionTerminalCommand } from './mobile-terminal-startup'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { OwnedMobileTerminalCreateOptions } from './mobile-terminal-create'
import { randomUUID } from 'node:crypto'
import { holderOfTabList } from '../../session-tabs/person/person-workspace-target'
import { copySleepingAgentLaunchConfig } from './runtime-agent-launch-resolution'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../identity/remote-runtime-terminal-create-identity'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { mintServePtySessionId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { placeCreatedSessionTab } from '../../../../shared/workspace-layout/tab-groups/session-tab-placement'
import { insertTabIdIntoOrder } from '../../../../shared/workspace-layout/tab-groups/tab-order'
import type { OrcaRuntimeWithBuildPtyTerminalSummary as PtyTerminalSummaryMethods } from '../query/pty-terminal-summary'
import {
  buildHeadlessMobileSessionTabGroups,
  buildMaterializedHeadlessParentLayout,
  getHeadlessMobileSessionGroupId
} from '../surface/mobile-session-layout-projection'

const OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS = 15 * 60_000

export abstract class OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal extends OrcaRuntimeWithResolveMobileSessionTerminalCommand {
  protected abstract createMobileSessionTabsDelivery(
    ...args: Parameters<SessionTabsPublication['createMobileSessionTabsDelivery']>
  ): ReturnType<SessionTabsPublication['createMobileSessionTabsDelivery']>

  protected abstract getPtyManualTitle(
    ...args: Parameters<PtyTerminalSummaryMethods['getPtyManualTitle']>
  ): ReturnType<PtyTerminalSummaryMethods['getPtyManualTitle']>

  private readonly ownedMobileDispatchRecipes = new Map<
    string,
    {
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      connectionId: string | null
      recordedAt: number
    }
  >()

  private pruneOwnedMobileDispatchRecipes(): void {
    const now = Date.now()
    for (const [handle, recipe] of this.ownedMobileDispatchRecipes) {
      if (now - recipe.recordedAt >= OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS) {
        this.ownedMobileDispatchRecipes.delete(handle)
      }
    }
  }

  /** `worktreeId` is the tab list it joins: a teammate's own workspace (`person:`) runs the terminal
   *  in their agent's Home, stamped as theirs (`holder`). */
  protected async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: OwnedMobileTerminalCreateOptions = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    this.pruneOwnedMobileDispatchRecipes()
    const { home, holder } = holderOfTabList(worktreeId)
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${home}`, undefined, {
      wslUserAct: opts.wslUserAct === true
    })
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Why: an SSH sessionId means reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
    const stableSessionId =
      opts.identity?.sessionId ??
      (workspace.connectionId ? undefined : mintServePtySessionId(workspace.id, randomUUID()))
    const isNewSession = stableSessionId !== undefined && opts.identity?.sessionId === undefined
    const mutationHandle = opts.createMutation
      ? deriveRemoteRuntimeTerminalCreateHandle(
          opts.createMutation.clientIdentity,
          worktreeId,
          opts.createMutation.id
        )
      : undefined
    const create = (preAllocatedHandle?: string) =>
      this.createTerminal(`id:${home}`, {
        focus: false,
        // A teammate's terminal is never revealed: no window shows their workspace.
        ...(holder ? { presentation: 'background' as const, holder } : {}),
        ...(opts.presentation && !holder ? { presentation: opts.presentation } : {}),
        ...(opts.afterDesktopTabId ? { afterTabId: opts.afterDesktopTabId } : {}),
        onPtySpawnDispatched: (launch) => {
          if (mutationHandle && launch) {
            if (
              !this.ownedMobileDispatchRecipes.has(mutationHandle) &&
              this.ownedMobileDispatchRecipes.size >= 4096
            ) {
              throw new Error('runtime_unavailable')
            }
            // Retain original dispatch evidence across an ambiguous response; retry payloads cannot replace it.
            this.ownedMobileDispatchRecipes.set(mutationHandle, {
              connectionId: workspace.connectionId ?? null,
              recordedAt: Date.now(),
              ...(launch.launchConfig
                ? { launchConfig: copySleepingAgentLaunchConfig(launch.launchConfig) }
                : {}),
              ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {})
            })
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
        ...(opts.trustWorktreeId ? { trustWorktreeId: opts.trustWorktreeId } : {}),
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
        ...(opts.resumesSleepingRecord ? { resumesSleepingRecord: true } : {}),
        ...(opts.reopensPane ? { reopensPane: true } : {})
      })
    const terminal = await (opts.createMutation
      ? this.dedupeTerminalCreate(
          opts.createMutation.clientIdentity,
          `id:${home}`,
          opts.createMutation.id,
          true,
          (_selector, handle) => create(handle),
          { wslUserAct: opts.wslUserAct === true }
        )
      : create())
    if (terminal.ptyId) {
      opts.onPtyCreated?.(terminal.ptyId, terminal)
    }
    const livePty = this.getLivePtyForHandle(terminal.handle)
    if (!livePty) {
      throw new Error('terminal_handle_stale')
    }
    if (opts.createMutation) {
      if (
        livePty.pty.launchAgent &&
        opts.launchAgent &&
        livePty.pty.launchAgent !== opts.launchAgent
      ) {
        throw new Error('terminal_create_identity_conflict')
      }
      const dispatchedRecipe =
        mutationHandle === terminal.handle && this.ownedMobileDispatchRecipes.get(terminal.handle)
      const recipe =
        dispatchedRecipe &&
        dispatchedRecipe.connectionId === (workspace.connectionId ?? null) &&
        (!livePty.pty.launchAgent || livePty.pty.launchAgent === dispatchedRecipe.launchAgent)
          ? dispatchedRecipe
          : null
      if (opts.launchConfig && !livePty.pty.launchConfig && !recipe?.launchConfig) {
        // Missing original dispatch evidence cannot authorize a retry's captured recipe.
        throw new Error('runtime_unavailable')
      }
      if (recipe) {
        livePty.pty.launchAgent ??= recipe.launchAgent ?? null
        // A finished launch's recipe must not return to the shell left behind.
        if (
          !livePty.pty.launchConfig &&
          recipe.launchConfig &&
          livePty.pty.launchEvidence?.kind !== 'gone'
        ) {
          livePty.pty.launchConfig = copySleepingAgentLaunchConfig(recipe.launchConfig)
        }
      }
      livePty.pty.runtimeSessionOwned = true
      if (mutationHandle) {
        this.ownedMobileDispatchRecipes.delete(mutationHandle)
      }
    }
    if (opts.createMutation && opts.identity && terminal.ptyId) {
      this.registerPty(terminal.ptyId, home, workspace.connectionId ?? null, {
        tabId: opts.identity.tabId,
        leafId: opts.identity.leafId,
        terminalHandle: terminal.handle
      })
    }
    const recorded = this.paneOfPty(livePty.pty)
    const parentTabId = recorded.tabId ?? `pty:${livePty.pty.ptyId}`
    const leafId = parsePaneKey(recorded.paneKey ?? '')?.leafId ?? randomUUID()
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
      ...(!terminal.agentResumeRefused && opts.viewMode ? { viewMode: opts.viewMode } : {}),
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
      activeGroupId:
        (activate ? tabGroups.find((group) => group.tabOrder.includes(parentTabId))?.id : null) ??
        existing?.activeGroupId ??
        getHeadlessMobileSessionGroupId(worktreeId),
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabGroups,
      // Retain split geometry when adding a tab.
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    // Store adds retirement proofs; emit that snapshot because version-deduping subscribers would miss proofs from a pre-store frame.
    const stored = this.storeMobileSessionSnapshot(worktreeId, next)
    if (activate && this.shouldPersistHeadlessMobileSessionActivation(stored, tab)) {
      this.persistHeadlessTerminalActiveLeaf(worktreeId, tab, stored)
    }
    const result = this.toMobileSessionTabsResult(stored)
    this.createMobileSessionTabsDelivery()(result, ++this.mobileSessionTabsChangeSequence)
    const created = result.tabs.find((candidate) => candidate.id === tab.id)
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    return {
      tab: created,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion,
      ...(terminal.startupCwdFallback ? { startupCwdFallback: 'workspace-root' as const } : {})
    }
  }
}
