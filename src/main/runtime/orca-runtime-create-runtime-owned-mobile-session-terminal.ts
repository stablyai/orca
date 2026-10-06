// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveMobileSessionTerminalCommand } from './orca-runtime-resolve-mobile-session-terminal-command'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { copySleepingAgentLaunchConfig } from './runtime-agent-launch-resolution'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { placeCreatedSessionTab } from '../../shared/session-tab-placement'
import {
  buildHeadlessMobileSessionTabGroups,
  buildMaterializedHeadlessParentLayout,
  getHeadlessMobileSessionGroupId
} from './mobile-session-layout-projection'
import { readHeadlessChatPairState } from './session-tab-chat-pair'

const OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS = 15 * 60_000

export class OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal extends OrcaRuntimeWithResolveMobileSessionTerminalCommand {
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

  protected async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: {
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      identity?: { tabId: string; leafId: string; sessionId?: string }
      createMutation?: { clientIdentity: string; id: string }
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      launcherDefaultView?: 'terminal' | 'chat'
      targetGroupId?: string
      supportsSplitGroupPlacement?: boolean
      launchConfig?: SleepingAgentLaunchConfig
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    this.pruneOwnedMobileDispatchRecipes()
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Why: SshPtyProvider treats sessionId as a relay reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
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
        ...(mutationHandle
          ? {
              onPtySpawnDispatched: (launch) => {
                if (!launch) {
                  return
                }
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
            }
          : {}),
        ...(preAllocatedHandle ? { preAllocatedHandle } : {}),
        command: opts.command,
        cwd,
        env: opts.env,
        envToDelete: opts.envToDelete,
        ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
        ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
        ...(opts.launcherDefaultView ? { launcherDefaultView: opts.launcherDefaultView } : {}),
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
        // Why: this method publishes the authoritative snapshot below; skip the intermediate publish to avoid a wrong-group flash.
        deferMobileSessionPublish: true,
        signal: opts.signal
      })
    const terminal = opts.createMutation
      ? await this.dedupeTerminalCreate(
          opts.createMutation.clientIdentity,
          `id:${worktreeId}`,
          opts.createMutation.id,
          true,
          (_selector, handle) => create(handle)
        )
      : await create()
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
        if (!livePty.pty.launchConfig && recipe.launchConfig) {
          livePty.pty.launchConfig = copySleepingAgentLaunchConfig(recipe.launchConfig)
        }
      }
      livePty.pty.runtimeSessionOwned = true
      if (mutationHandle) {
        this.ownedMobileDispatchRecipes.delete(mutationHandle)
      }
    }
    if (opts.createMutation && opts.identity && terminal.ptyId) {
      this.registerPty(terminal.ptyId, worktreeId, workspace.connectionId ?? null, {
        tabId: opts.identity.tabId,
        leafId: opts.identity.leafId,
        terminalHandle: terminal.handle
      })
    }
    const parentTabId = livePty.pty.tabId ?? `pty:${livePty.pty.ptyId}`
    const leafId = parsePaneKey(livePty.pty.paneKey ?? '')?.leafId ?? randomUUID()
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    // Why: the PTY admission already committed the fresh tab's view; an adopted or deduped tab keeps
    // its own (absence included), so raw request options are never persisted over it.
    const committed = readHeadlessChatPairState(
      this.getWorkspaceSessionForWorktree(worktreeId),
      existing,
      worktreeId,
      parentTabId
    )
    const startingView = committed
      ? committed.pair
      : opts.viewMode
        ? { viewMode: opts.viewMode, ...(opts.viewMode === 'chat' ? { chatLeafId: leafId } : {}) }
        : {}
    const existingSurface =
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === parentTabId &&
          candidate.leafId === leafId
      ) ?? null
    const builtLayout = buildMaterializedHeadlessParentLayout(
      leafId,
      livePty.pty.ptyId,
      existingSurface?.parentLayout
    )
    const parentLayout =
      !existingSurface?.parentLayout &&
      startingView.chatLeafId === leafId &&
      !builtLayout.chatLeafId
        ? { ...builtLayout, chatLeafId: leafId }
        : builtLayout
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      ptyId: livePty.pty.ptyId,
      incarnationId: livePty.pty.incarnationId,
      title: terminal.title ?? livePty.pty.title ?? 'Terminal',
      ...(cwd ? { startupCwd: cwd } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(startingView.viewMode ? { viewMode: startingView.viewMode } : {}),
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
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      // Why: a fresh epoch retires the current publisher, so clients drop its later tab updates.
      publicationEpoch: existing?.publicationEpoch ?? `headless:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      // Why: activating the new tab also focuses its group, so a "+" targeting a specific split group makes that group active too.
      activeGroupId:
        activate && opts.targetGroupId
          ? opts.targetGroupId
          : (existing?.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId)),
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activate ? tab : null,
        existing?.tabGroups,
        opts.targetGroupId ? { tabId: parentTabId, groupId: opts.targetGroupId } : undefined
      ),
      // Why: keep group split geometry on new-tab creation, else opening a terminal while split loses the arrangement.
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    // Why: emit the stored snapshot, not the pre-store one — storing grafts on retirement
    // proofs, and subscribers dedupe on version so they would never see them otherwise.
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
    return {
      tab: created,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }
}
