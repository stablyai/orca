import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as MobileSessionPublication } from '../../session-tabs/session-tabs-change-publication'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as MobileSessionPreservation } from '../../session-tabs/mobile-session-publication-preservation'
import { OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh } from './perform-mobile-session-pty-records-refresh'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { navigationTargetsClients } from '../../../../shared/runtime-navigation'
import {
  activateClientSessionTabSelection,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from '../../client-session-tab-selection-projection'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type {
  MobileTerminalResumeCommand,
  OrcaRuntimeWithResolveMobileSessionTerminalCommand as MobileTerminalStartup
} from '../../terminal/launch/mobile-terminal-startup'
import type { OrcaRuntimeWithStopTerminalsForWorktree as SessionEditHost } from '../../terminal/stop/worktree-terminal-stop'
import { claimWindowWakeRecordForPane, isWindowWakeSleepRecord } from './window-wake-sleep-record'
import {
  buildHeadlessMobileSessionTabGroups,
  cloneTerminalLayoutSnapshot
} from '../../mobile-session-layout-projection'
import { findPaneSleepingRecord } from './pane-sleeping-record'

export abstract class OrcaRuntimeWithApplyMobileSessionTabNavigation extends OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh {
  protected abstract emitMobileSessionTabsSnapshotToClient(
    ...args: Parameters<MobileSessionPublication['emitMobileSessionTabsSnapshotToClient']>
  ): ReturnType<MobileSessionPublication['emitMobileSessionTabsSnapshotToClient']>
  protected abstract resolveMobileSessionResumeCommand(
    ...args: Parameters<MobileTerminalStartup['resolveMobileSessionResumeCommand']>
  ): ReturnType<MobileTerminalStartup['resolveMobileSessionResumeCommand']>
  protected abstract isHeadlessMobileSessionPublication(
    ...args: Parameters<MobileSessionPreservation['isHeadlessMobileSessionPublication']>
  ): ReturnType<MobileSessionPreservation['isHeadlessMobileSessionPublication']>
  protected abstract commitWorkspaceSessionEdit(
    ...args: Parameters<SessionEditHost['commitWorkspaceSessionEdit']>
  ): ReturnType<SessionEditHost['commitWorkspaceSessionEdit']>

  protected applyMobileSessionTabNavigation(
    snapshot: RuntimeMobileSessionTabsResult,
    activeTabId: string,
    navigation: RuntimeNavigationTarget,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    let callerSnapshot: RuntimeMobileSessionTabsResult | null = null
    if (navigationTargetsClients(navigation)) {
      // Why: follow is live intent; disconnected devices must not inherit stale navigation on reconnect.
      const ids = new Set(
        [...this.mobileSessionTabListeners]
          .map((subscription) => subscription.clientNavigationId)
          .filter((id): id is string => Boolean(id))
      )
      if (clientNavigationId) {
        ids.add(clientNavigationId)
      }
      for (const id of ids) {
        const projected = this.clientSessionTabSelections.activate(
          this.withSessionTabsHolds(snapshot, id),
          id,
          activeTabId
        )
        this.emitMobileSessionTabsSnapshotToClient(projected, id, true)
        if (id === clientNavigationId) {
          callerSnapshot = projected
        }
      }
    } else if (clientNavigationId) {
      // Why: follow-host still starts as caller navigation; the host is an additional target, not a replacement owner.
      callerSnapshot = this.clientSessionTabSelections.activate(
        this.withSessionTabsHolds(snapshot, clientNavigationId),
        clientNavigationId,
        activeTabId
      )
      this.emitMobileSessionTabsSnapshotToClient(callerSnapshot, clientNavigationId)
    }
    if (clientNavigationId) {
      return callerSnapshot ?? this.projectMobileSessionTabsForClient(snapshot, clientNavigationId)
    }
    if (navigation === 'caller') {
      const selection = activateClientSessionTabSelection(
        snapshot,
        deriveClientSessionTabSelection(snapshot),
        activeTabId
      )
      return projectClientSessionTabSelection(snapshot, selection).snapshot
    }
    return snapshot
  }

  /**
   * Records a tab a create just published as one paired client's selection, as a create does for
   * its own tab. Not the tap path: a tap is a wake gesture that may respawn a non-ready pane.
   * Returns false when the tab is not in the snapshot.
   */
  selectCreatedMobileSessionTabForClient(
    worktreeId: string,
    surface: { tabId: string; leafId: string } | { sessionId: string },
    clientNavigationId: string
  ): boolean {
    const snapshot = this.getMobileSessionTabsForWorktree(worktreeId)
    const tab = snapshot.tabs.find((candidate) =>
      'sessionId' in surface
        ? candidate.type === 'agent-session' && candidate.sessionId === surface.sessionId
        : candidate.type === 'terminal' &&
          candidate.parentTabId === surface.tabId &&
          candidate.leafId === surface.leafId
    )
    if (!tab) {
      return false
    }
    this.applyMobileSessionTabNavigation(snapshot, tab.id, 'caller', clientNavigationId)
    return true
  }

  /**
   * Whether persistence proves this pane's PTY was deliberately taken down and parked
   * (workspace sleep or completed-agent hibernation) rather than lost and awaiting reconnect.
   * Why: `pending-handle` alone cannot tell those apart — a parked pane publishes it
   * indefinitely — and respawning a parked pane re-launches its agent behind the user.
   * Only an automatic activation consults this; a user opening the tab is the wake gesture.
   */
  protected isDeliberatelyParkedPane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    // Why: 'live'/'quit' captures describe a pane that was still running, so a reconnect
    // must still mint its replacement PTY (#11542). Only a worktree-owned capture records
    // a deliberate takedown the user did not ask to undo.
    return this.getPaneSleepingAgentRecord(worktreeId, tab)?.origin === 'worktree-sleep'
  }

  /**
   * The record the host window's cold restore would resume this pane from, if the pane owns it.
   * Why: a running agent's worktree-sleep record is relaunched in a fresh tab by the window's
   * worktree activation, so resuming it in the pane as well would run one transcript twice.
   */
  protected getPaneOwnedResumeRecord(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): SleepingAgentSessionRecord | null {
    const record = this.getPaneSleepingAgentRecord(worktreeId, tab)
    if (!record) {
      return null
    }
    // Why: an originless record predates capture origins and carries no proof of which pane or
    // host wrote it, so it is left (record kept) for the window's legacy cleanup (#29303).
    // A host with no window right now has no window wake, so the pane owns the record and claims it.
    // Switch point: a layout-owner window never wakes a pane itself, so main owns every wake.
    const paneOwned =
      record.origin === 'live' ||
      record.origin === 'quit' ||
      (record.origin === 'worktree-sleep' &&
        (record.state === 'done' ||
          ORCA_LAYOUT_OWNER_IS_MAIN ||
          !this.getAvailableAuthoritativeWindow()))
    return paneOwned ? record : null
  }

  /**
   * The pane's resume launch: undefined when it owns no record, `{}` (plain shell, record kept,
   * as the window does) when the record cannot be resumed here or the window will wake it.
   */
  protected async resolvePaneOwnedResumeStartup(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): Promise<MobileTerminalResumeCommand | Record<string, never> | undefined> {
    const record = this.getPaneOwnedResumeRecord(worktreeId, tab)
    if (!record) {
      const unowned = this.getPaneSleepingAgentRecord(worktreeId, tab)
      // Why: a fresh launch would drop the conversation and its recorded flags (#29672).
      return unowned && isWindowWakeSleepRecord(unowned) ? {} : undefined
    }
    // Why: nothing here spends the record, so a session another pane also records could be
    // resumed twice (two writers on one transcript), as could one already live in another pane.
    const records = this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey
    const aliases = this.findPaneSleepingAgentRecord(worktreeId, tab)?.aliases ?? []
    const sharedWithAnotherPane = Object.entries(records ?? {}).some(
      ([paneKey, other]) =>
        other !== record &&
        !aliases.includes(paneKey) &&
        other.agent === record.agent &&
        agentProviderSessionsEqual(record.agent, other.providerSession, record.providerSession)
    )
    if (
      sharedWithAnotherPane ||
      (await this.isProviderSessionLiveInAnotherPane(record)) ||
      this.hookStoreNamesAnotherSessionForPane(record)
    ) {
      return {}
    }
    let resume: MobileTerminalResumeCommand | null
    try {
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
      resume = this.resolveMobileSessionResumeCommand(workspace, record)
    } catch {
      return {}
    }
    if (!resume || !isWindowWakeSleepRecord(record)) {
      return resume ?? {}
    }
    const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    const claimed = await claimWindowWakeRecordForPane(
      (edit) => this.commitWorkspaceSessionEdit(hostId, edit),
      // Why: a window that attached during the awaits above now owns this record's wake.
      // Switch point: a layout-owner window never starts a terminal, so main owns every wake.
      () => !ORCA_LAYOUT_OWNER_IS_MAIN && Boolean(this.getAvailableAuthoritativeWindow()),
      record
    )
    return claimed ? resume : {}
  }

  /** The host's hook store places this conversation in another pane not proven exited. */
  private async isProviderSessionLiveInAnotherPane(
    record: SleepingAgentSessionRecord
  ): Promise<boolean> {
    const otherPaneKeys = new Set(
      (this.getAgentProviderSessionSnapshotFn?.() ?? [])
        .filter(
          (row) =>
            row.paneKey !== record.paneKey &&
            agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession)
        )
        .map((row) => row.paneKey)
    )
    // Why: only a proven exit clears a holder; an unverifiable PTY (dropped SSH relay) or one not
    // yet hydrated after a restart may still be writing the transcript.
    const ptys = [...this.ptysById.values()]
    const holderPaneKeys = [...otherPaneKeys].filter((paneKey) => {
      const panePtys = ptys.filter((pty) => pty.paneKey === paneKey)
      return panePtys.length === 0 || panePtys.some((pty) => !this.isPtyKnownExited(pty.ptyId))
    })
    if (holderPaneKeys.length === 0) {
      return false
    }
    // Why: a shell can outlive the agent; the hook store's proven exit releases a pane whose PTY lives.
    const verdicts = await Promise.all(
      holderPaneKeys.map((paneKey) =>
        this.checkHookAgentPresenceFn
          ? this.checkHookAgentPresenceFn(paneKey, 0).catch(() => null)
          : Promise.resolve(null)
      )
    )
    return verdicts.some((verdict) => verdict !== 'exited')
  }

  /** The pane moved on to another conversation after the record was saved; the hook store is authoritative. */
  private hookStoreNamesAnotherSessionForPane(record: SleepingAgentSessionRecord): boolean {
    return (this.getAgentProviderSessionRowsForPaneFn?.(record.paneKey) ?? []).some(
      (row) =>
        row.providerSession !== undefined &&
        !agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession)
    )
  }

  private getPaneSleepingAgentRecord(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): SleepingAgentSessionRecord | null {
    return this.findPaneSleepingAgentRecord(worktreeId, tab)?.record ?? null
  }

  private findPaneSleepingAgentRecord(worktreeId: string, tab: RuntimeMobileSessionTerminalTab) {
    return findPaneSleepingRecord(this.getWorkspaceSessionForWorktree(worktreeId), worktreeId, tab)
  }

  protected shouldMaterializeHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return (
      this.isHeadlessMobileSessionPublication(snapshot.publicationEpoch) ||
      this.hasServeOrSshOwnedBinding(tab)
    )
  }

  protected shouldPersistHeadlessMobileSessionActivation(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    if (snapshot.publicationEpoch.includes(':headless-merge:')) {
      return false
    }
    if (this.authoritativeWindowId !== null && this.graphStatus === 'ready') {
      return false
    }
    return this.shouldMaterializeHeadlessMobileSessionTab(snapshot, tab)
  }

  protected activateHeadlessMobileSessionTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    activeTab: RuntimeMobileSessionTerminalTab
  ): void {
    const tabs = snapshot.tabs.map((candidate) => ({
      ...candidate,
      isActive: candidate.id === activeTab.id
    }))
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: activeTab.id,
      activeTabType: 'terminal',
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activeTab,
        snapshot.tabGroups
      ),
      tabs
    }
    this.persistHeadlessTerminalActiveLeaf(worktreeId, activeTab)
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  protected persistHeadlessTerminalActiveLeaf(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const existingLayout = session.terminalLayoutsByTabId?.[tab.parentTabId]
    const nextLayouts = existingLayout
      ? {
          ...session.terminalLayoutsByTabId,
          [tab.parentTabId]: {
            ...cloneTerminalLayoutSnapshot(existingLayout),
            activeLeafId: tab.leafId
          }
        }
      : session.terminalLayoutsByTabId
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      activeTabId: tab.parentTabId,
      activeTabIdByWorktree: {
        ...session.activeTabIdByWorktree,
        [worktreeId]: tab.parentTabId
      },
      terminalLayoutsByTabId: nextLayouts
    })
  }
}
