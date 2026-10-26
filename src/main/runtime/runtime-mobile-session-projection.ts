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
import { resolveTerminalTabTitle } from '../../shared/tab-title-resolution'
import { indexAgentStatusRowsByPaneKey } from '../agent-hooks/agent-status-pane-index'
import {
  demoteRuntimeMobileAgentStatus,
  renewRuntimeMobileAgentStatusFromPtyTitle,
  selectRuntimeHookAgentRowForPane
} from './runtime-mobile-agent-status-projection'
import { finalizeRuntimeMobileSessionTabsResult } from './runtime-mobile-session-result-finalization'
import { withStructuredChatStatus } from './runtime-mobile-structured-tab-status'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import {
  getLatestAgentCandidateTitle,
  getLeafDisplayRecord,
  getPtyDisplayRecord,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-worktree-status-projection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

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
  let statusRowsByPaneKey: Map<string, AgentStatusIpcPayload[]> | null = null
  let statusRowsByTerminalHandle: Map<string, AgentStatusIpcPayload[]> | null = null
  const getStatusRows = (
    paneKey: string,
    terminalHandle: string | null
  ): AgentStatusIpcPayload[] => {
    if (!statusRowsByPaneKey || !statusRowsByTerminalHandle) {
      statusRowsByPaneKey = new Map()
      statusRowsByTerminalHandle = new Map()
      for (const row of host.getStatusSnapshot()) {
        const paneRows = statusRowsByPaneKey.get(row.paneKey)
        if (paneRows) {
          paneRows.push(row)
        } else {
          statusRowsByPaneKey.set(row.paneKey, [row])
        }
        if (row.terminalHandle) {
          const handleRows = statusRowsByTerminalHandle.get(row.terminalHandle)
          if (handleRows) {
            handleRows.push(row)
          } else {
            statusRowsByTerminalHandle.set(row.terminalHandle, [row])
          }
        }
      }
    }
    const paneRows = statusRowsByPaneKey.get(paneKey) ?? []
    if (!terminalHandle) {
      return paneRows
    }
    const handleRows = statusRowsByTerminalHandle.get(terminalHandle) ?? []
    if (paneRows.length === 0) {
      return handleRows
    }
    return [...paneRows, ...handleRows.filter((row) => !paneRows.includes(row))]
  }
  // Claim each live PTY once or duplicate leaf keys crash client React.
  const claimedLivePtyIds = new Set<string>()
  for (const tab of snapshot.tabs) {
    if (tab.type === 'browser') {
      const liveTab = tab.browserPageId ? liveBrowserTabsByPageId.get(tab.browserPageId) : undefined
      if (!liveTab) {
        continue
      }
      // Renderer snapshots lag teardown/swaps; expose only pages the bridge still routes.
      tabs.push({
        ...tab,
        title: liveTab.title || tab.title,
        url: liveTab.url || tab.url,
        // Bridge active means BrowserView/webContents, not Orca tab; retain renderer session focus.
        isActive: tab.isActive
      })
      continue
    }
    if (tab.type === 'markdown' || tab.type === 'file') {
      tabs.push(tab)
      continue
    }
    if (tab.type === 'agent-session') {
      tabs.push(withStructuredChatStatus(tab, snapshot.worktree, getHookRowsForPane))
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
    // Drop later tabs sharing an already-claimed PTY so handles stay unique.
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
    // Use one main hook lookup for both headless title ownership and status to prevent divergence.
    const retainedAgentStatus = tab.agentStatus
      ? null
      : host.getRetainedStatus(paneKey, liveLeafPty ?? mobileStatusPty, tab, getStatusRows)
    const hookAgentStatus = tab.agentStatus
      ? selectRuntimeHookAgentRowForPane(getHookRowsForPane(paneKey))
      : null
    // Do not revive rejected persisted tab.ptyId; after restart it may name another pane and publish its title here.
    const trackerOnlyTitle = host.getTrackedTitle(liveLeafPtyId ?? pty?.ptyId ?? null)
    const displayLeaf = leaf
      ? getLeafDisplayRecord(leaf, host.getTitleDisplayClear(leaf.ptyId))
      : null
    const displayPty = pty ? getPtyDisplayRecord(pty, host.getTitleDisplayClear(pty.ptyId)) : null
    const leafTitle = displayLeaf
      ? getLatestAgentCandidateTitle(
          { title: displayLeaf.paneTitle, updatedAt: displayLeaf.paneTitleUpdatedAt },
          { title: displayLeaf.lastOscTitle, updatedAt: displayLeaf.lastOscTitleAt }
        )
      : null
    const ptyTitle = displayPty
      ? getLatestAgentCandidateTitle(
          { title: displayPty.title, updatedAt: displayPty.titleUpdatedAt },
          { title: displayPty.lastOscTitle, updatedAt: displayPty.lastOscTitleAt }
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
    const liveTitle = trackerOnlyTitle ?? leafTitle ?? ptyTitle ?? syncedTab?.title ?? tab.title
    const agentTitle = normalizeCompatibleAgentTitleForOwner(liveTitle, ownerAgent, ownerOptions)
    // Preserve desktop ranking over fresher main titles; window emits generated names only while shown.
    const title = resolveTerminalTabTitle({ ...tab, title: agentTitle }, true, agentTitle)
    const liveTitleEvidence = leafTitle ?? ptyTitle
    // Renderer status may precede hook session identity; native chat still needs a transcript address.
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
    const nativeStatusPty = liveLeafPty ?? mobileStatusPty
    const statusPty = nativeStatusPty
      ? getPtyDisplayRecord(nativeStatusPty, host.getTitleDisplayClear(nativeStatusPty.ptyId))
      : null
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
    // Live prompt/tool status must survive non-agent titles or interactivePrompt disappears.
    const hasLiveAgentSignal =
      normalizedTabAgentStatus?.interactivePrompt != null ||
      normalizedTabAgentStatus?.toolName != null
    // A title renew already dated against the hook (e.g. ConPTY's spawn-time shell title) cannot re-demote it (#32467).
    const hookOutlivedAdjudicatedTitle =
      normalizedTabAgentStatus?.state !== 'done' &&
      statusPty?.lastOscTitleEpochMs != null &&
      liveTitleEvidence === (statusPty.lastOscTitle?.trim() || null)
    // Only shell/management proves release; neutral Terminal/editor/cwd titles cannot justify done that fights clients' live status.
    const keepFullAgentStatus =
      normalizedTabAgentStatus &&
      (hookOutlivedAdjudicatedTitle ||
        !terminalTitleBlocksExplicitAgentStatus(liveTitleEvidence) ||
        hasLiveAgentSignal)
    const agentStatus = keepFullAgentStatus
      ? { agentStatus: normalizedTabAgentStatus }
      : // Idle titles drop stale working spinners but retain transcript identity for native chat.
        normalizedTabAgentStatus?.agentType != null
        ? {
            agentStatus: demoteRuntimeMobileAgentStatus(normalizedTabAgentStatus, statusPty)
          }
        : null
    // PTY handles survive renderer graph syncs; epoch-bound leaf handles do not.
    const terminalPty = liveLeafPtyId
      ? host.recordPty(liveLeafPtyId, snapshot.worktree, {
          tabId: tab.parentTabId,
          paneKey,
          connected: true
        })
      : livePty
    const terminalHandle = terminalPty ? host.issuePtyHandle(terminalPty) : null
    const projectedAgentStatus =
      agentStatus ??
      host.buildPtyStatus(
        // Main layout supplies the live pane leaf whose terminal owns status.
        ORCA_LAYOUT_OWNER_IS_MAIN ? (liveLeafPty ?? mobileStatusPty) : mobileStatusPty,
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
      ...(tab.customTitle !== undefined ? { customTitle: tab.customTitle } : {}),
      ...(tab.ptyId ? { ptyId: tab.ptyId } : {}),
      // Bind identity to the handle's live owner, never a stale persisted surface.
      ...(terminalPty?.incarnationId ? { incarnationId: terminalPty.incarnationId } : {}),
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
