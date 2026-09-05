import {
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../shared/agent-title-owner'
import { resolvePaneAgentOwnerRecord } from '../../shared/pane-agent-owner'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { indexAgentStatusRowsByPaneKey } from '../agent-hooks/agent-status-pane-index'
import {
  renewRuntimeMobileAgentStatusFromPtyTitle,
  selectRuntimeHookAgentRowForPane
} from './runtime-mobile-agent-status-projection'
import { finalizeRuntimeMobileSessionTabsResult } from './runtime-mobile-session-result-finalization'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import {
  getLatestAgentCandidateTitle,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-worktree-status-projection'

export function projectRuntimeMobileSessionTabs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  host: RuntimeMobileSessionProjectionHost
): RuntimeMobileSessionTabsResult {
  const tabs: RuntimeMobileSessionClientTab[] = []
  const liveBrowserTabsByPageId = host.getLiveBrowserTabs(snapshot.worktree)
  // Production reads hook rows by pane; the snapshot fallback remains for tests
  // and embedders that have not adopted the narrow getter.
  let hookRowsByPaneKey: Map<string, AgentStatusIpcPayload[]> | null = null
  const hookRowsForPane = new Map<string, AgentStatusIpcPayload[]>()
  const getHookRowsForPane = (paneKey: string): AgentStatusIpcPayload[] => {
    const cached = hookRowsForPane.get(paneKey)
    if (cached) {
      return cached
    }
    const direct = host.getProviderSessionRows(paneKey)
    if (direct) {
      hookRowsForPane.set(paneKey, direct)
      return direct
    }
    hookRowsByPaneKey ??= indexAgentStatusRowsByPaneKey(host.getProviderSessionSnapshot())
    const rows = hookRowsByPaneKey.get(paneKey) ?? []
    hookRowsForPane.set(paneKey, rows)
    return rows
  }
  // Why: a live PTY backs one surface; claim each once so two leaves resolving to it can't emit duplicate React keys and crash the client.
  const claimedLivePtyIds = new Set<string>()
  for (const tab of snapshot.tabs) {
    if (tab.type === 'browser') {
      const liveTab = tab.browserPageId ? liveBrowserTabsByPageId.get(tab.browserPageId) : undefined
      if (!liveTab) {
        continue
      }
      // Why: renderer snapshots lag BrowserView teardown/process swaps; only surface pages the browser bridge can still route to.
      tabs.push({
        ...tab,
        title: liveTab.title || tab.title,
        url: liveTab.url || tab.url,
        // Why: bridge "active" means active BrowserView/webContents, not active Orca tab; preserve the renderer's session focus.
        isActive: tab.isActive
      })
      continue
    }
    if (tab.type === 'markdown' || tab.type === 'file') {
      tabs.push(tab)
      continue
    }
    if (tab.type === 'agent-session') {
      tabs.push(tab)
      continue
    }
    const syncedTab = host.tabs.get(tab.parentTabId)
    const leaf = host.leaves.get(host.getLeafKey(tab.parentTabId, tab.leafId)) ?? null
    const liveLeaf = leaf?.ptyId && leaf.connected ? leaf : null
    const liveLeafPtyId = liveLeaf?.ptyId ?? null
    const liveLeafPty = liveLeafPtyId ? (host.ptysById.get(liveLeafPtyId) ?? null) : null
    const pty = liveLeaf
      ? null
      : host.findPty(snapshot.worktree, tab, {
          allowWorktreeOnlyMatch: !snapshot.publicationEpoch.startsWith('headless')
        })
    const livePty = pty?.connected ? pty : null
    // Why: enforce one-live-PTY-per-tab; drop a later tab resolving to an already-claimed PTY so no two tabs share a handle.
    const resolvedLivePtyId = liveLeafPtyId ?? livePty?.ptyId ?? null
    if (resolvedLivePtyId !== null) {
      if (claimedLivePtyIds.has(resolvedLivePtyId)) {
        continue
      }
      claimedLivePtyIds.add(resolvedLivePtyId)
    }
    const legacyPaneId = /^pane:(\d+)$/.exec(tab.leafId)?.[1] ?? null
    const paneKey = isTerminalLeafId(tab.leafId)
      ? makePaneKey(tab.parentTabId, tab.leafId)
      : `${tab.parentTabId}:${legacyPaneId ?? tab.leafId}`
    const mobileStatusPty = livePty ?? pty
    // Why: headless hooks live only in main's retained rows; reuse this lookup
    // for both title ownership and status publication so the two cannot diverge.
    const retainedAgentStatus = tab.agentStatus
      ? null
      : host.getRetainedStatus(paneKey, liveLeafPty ?? mobileStatusPty, tab)
    const hookAgentStatus = tab.agentStatus
      ? selectRuntimeHookAgentRowForPane(getHookRowsForPane(paneKey))
      : null
    // Why not tab.ptyId: findPtyForMobileTerminalTab already rejected it when it returned
    // null, because persisted ids can collide with an unrelated pane after restart — reading
    // that pane's tracker would publish its title here, ahead of every other source.
    const trackerOnlyTitle = host.getTrackedTitle(liveLeafPtyId ?? pty?.ptyId ?? null)
    const leafTitle = leaf
      ? getLatestAgentCandidateTitle(
          { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
          { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
        )
      : null
    const ptyTitle = pty
      ? getLatestAgentCandidateTitle(
          { title: pty.title, updatedAt: pty.titleUpdatedAt },
          { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
        )
      : null
    // Renderer omission is authoritative: PTY launch provenance outlives agent exit.
    const launchAgent = tab.launchAgent ?? null
    const launchOwnerAgent = launchAgent ?? liveLeafPty?.launchAgent ?? pty?.launchAgent ?? null
    // Why: a retained OMP hook stays stable while wrapper foreground reads can report Pi.
    const ownerRecord = resolvePaneAgentOwnerRecord({
      launchAgent: launchOwnerAgent,
      hookAgent:
        tab.agentStatus?.agentType ??
        hookAgentStatus?.agentType ??
        retainedAgentStatus?.payload.agentType ??
        null
    })
    const ownerAgent =
      ownerRecord?.agent ?? liveLeafPty?.foregroundAgent ?? pty?.foregroundAgent ?? null
    const ownerOptions = { ownerIsLaunch: ownerRecord?.ownerIsLaunch === true }
    const title = normalizeCompatibleAgentTitleForOwner(
      trackerOnlyTitle ?? leafTitle ?? ptyTitle ?? syncedTab?.title ?? tab.title,
      ownerAgent,
      ownerOptions
    )
    const liveTitleEvidence = leafTitle ?? ptyTitle
    // Why: renderer status can precede hook session identity, leaving native chat with no transcript address.
    const rendererStatusAgent =
      resolveCompatibleAgentTypeForOwner(tab.agentStatus?.agentType, ownerAgent, ownerOptions) ??
      ownerAgent ??
      undefined
    const hookSessionAgent = resolveCompatibleAgentTypeForOwner(
      hookAgentStatus?.providerSessionAgentType,
      ownerAgent,
      ownerOptions
    )
    const hookSessionMatchesRenderer =
      !rendererStatusAgent || !hookSessionAgent || rendererStatusAgent === hookSessionAgent
    const hookProviderSession =
      hookAgentStatus?.providerSession &&
      hookSessionMatchesRenderer &&
      (!tab.agentStatus?.providerSession ||
        (hookAgentStatus.providerSessionReceivedAt ?? -1) >= tab.agentStatus.updatedAt)
        ? hookAgentStatus.providerSession
        : tab.agentStatus?.providerSession
    const statusPty = liveLeafPty ?? mobileStatusPty
    const normalizedTabAgentStatus = renewRuntimeMobileAgentStatusFromPtyTitle(
      tab.agentStatus
        ? normalizeCompatibleAgentStatusEntryForOwner(
            {
              ...tab.agentStatus,
              ...(hookProviderSession ? { providerSession: hookProviderSession } : {})
            },
            ownerAgent,
            ownerOptions
          )
        : null,
      statusPty,
      { preserveQuestionUnderShellTitle: true }
    )
    // Why: keep rich status on a live prompt/tool, or interactivePrompt is lost under a non-agent title.
    const hasLiveAgentSignal =
      normalizedTabAgentStatus?.interactivePrompt != null ||
      normalizedTabAgentStatus?.toolName != null
    // Why: only shell/management evidence proves the agent released the pane
    // (same predicate as the terminal-status API). A merely neutral live title
    // — 'Terminal', an editor, a cwd — proves nothing, and treating it as
    // completion published a synthetic `done` that fought the client's own
    // live status on every republication.
    const keepFullAgentStatus =
      normalizedTabAgentStatus &&
      (!terminalTitleBlocksExplicitAgentStatus(liveTitleEvidence) || hasLiveAgentSignal)
    const agentStatus = keepFullAgentStatus
      ? { agentStatus: normalizedTabAgentStatus }
      : // Why: idle live title → drop stale "working" (no spinner) but keep agent identity so native chat can still address the transcript.
        normalizedTabAgentStatus?.agentType != null
        ? {
            agentStatus: {
              state: 'done' as const,
              prompt: '',
              updatedAt: statusPty?.lastOscTitleEpochMs ?? normalizedTabAgentStatus.updatedAt,
              stateStartedAt:
                statusPty?.lastAgentStatusStartedAtEpochMs ??
                normalizedTabAgentStatus.stateStartedAt,
              paneKey: normalizedTabAgentStatus.paneKey,
              stateHistory: [],
              agentType: normalizedTabAgentStatus.agentType,
              ...(normalizedTabAgentStatus.providerSession
                ? { providerSession: normalizedTabAgentStatus.providerSession }
                : {})
            }
          }
        : null
    // Why: web/mobile clients hold handles across renderer graph syncs; leaf handles are epoch-bound but PTY handles stay streamable.
    const terminalHandle = liveLeafPtyId
      ? host.issuePtyHandle(
          host.recordPty(liveLeafPtyId, snapshot.worktree, {
            tabId: tab.parentTabId,
            paneKey,
            connected: true
          })
        )
      : livePty
        ? host.issuePtyHandle(livePty)
        : null
    const projectedAgentStatus =
      agentStatus ??
      host.buildPtyStatus(
        mobileStatusPty,
        tab,
        terminalHandle,
        retainedAgentStatus,
        getHookRowsForPane
      )
    const projectedStatusEntry = projectedAgentStatus.agentStatus as
      | (AgentStatusEntry & { turnCompletedAt?: number })
      | undefined
    const { turnCompletedAt: projectedTurnCompletedAt, ...clientStatusFields } =
      projectedStatusEntry ?? {}
    const rawTurnCompletedAt =
      hookAgentStatus?.live?.payload.turnCompletedAt ??
      selectRuntimeHookAgentRowForPane(getHookRowsForPane(paneKey)).live?.payload.turnCompletedAt ??
      projectedTurnCompletedAt
    const turnCompletedAt =
      typeof rawTurnCompletedAt === 'number' && Number.isFinite(rawTurnCompletedAt)
        ? rawTurnCompletedAt
        : undefined
    const clientAgentStatus: { agentStatus?: AgentStatusEntry } = projectedStatusEntry
      ? { agentStatus: clientStatusFields as AgentStatusEntry }
      : {}
    tabs.push({
      type: 'terminal',
      id: tab.id,
      parentTabId: tab.parentTabId,
      leafId: tab.leafId,
      title,
      ...(tab.ptyId ? { ptyId: tab.ptyId } : {}),
      ...(tab.terminalTheme ? { terminalTheme: tab.terminalTheme } : {}),
      ...(launchAgent ? { launchAgent } : {}),
      ...clientAgentStatus,
      ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {}),
      ...(tab.parentLayout ? { parentLayout: tab.parentLayout } : {}),
      ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
      ...(tab.color != null ? { color: tab.color } : {}),
      ...(tab.isPinned ? { isPinned: true } : {}),
      ...(tab.viewMode ? { viewMode: tab.viewMode } : {}),
      ...(tab.launchDraft ? { launchDraft: tab.launchDraft } : {}),
      ...(tab.launchDraftCreatedAt !== undefined
        ? { launchDraftCreatedAt: tab.launchDraftCreatedAt }
        : {}),
      isActive: tab.isActive,
      ...(terminalHandle
        ? { status: 'ready' as const, terminal: terminalHandle }
        : { status: 'pending-handle' as const, terminal: null })
    })
  }
  return finalizeRuntimeMobileSessionTabsResult({ snapshot, tabs }, host)
}
