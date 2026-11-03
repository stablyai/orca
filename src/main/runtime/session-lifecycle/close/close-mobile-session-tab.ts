import { OrcaRuntimeWithCloseMobileRowInMainLayout } from './close-mobile-row-in-main-layout'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'
import {
  adjudicateAbsentMobileSessionTabClose,
  resolveMobileSessionLifecycleCloseContext,
  type MobileSessionLifecycleCloseHost
} from '../../mobile-session-lifecycle-close-adjudication'
import {
  committedMobileSessionTabClose,
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose,
  type MobileSessionTabCloseOutcome,
  type MobileSessionTabCloseOptions
} from '../../mobile-session-tab-close-outcome'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'
import type { RuntimeEdgeCommandSurface } from '../../runtime-edge-command-controller'
import { rendererPublicationThrottle } from '../../../window/renderer-publication-throttle'
import { retireHeadlessMobileSessionEditorTab } from '../../mobile-session-editor-projection'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { closeMobileStructuredSessionPresentation } from '../../session-tabs/structured-session-tab-presentation'
import type { OrcaRuntimeWithCloseStructuredAgentSessionTab as ChatPresentation } from '../../session-tabs/structured-session-tab-close'

export abstract class OrcaRuntimeWithCloseMobileSessionTab extends OrcaRuntimeWithCloseMobileRowInMainLayout {
  abstract retireStructuredAgentSessionTabFromSnapshot(
    sessionId: string,
    expectedTabId?: string,
    expectedWorktreeId?: string
  ): boolean

  abstract currentLocalStructuredSessionPresentation(
    ...args: Parameters<ChatPresentation['currentLocalStructuredSessionPresentation']>
  ): ReturnType<ChatPresentation['currentLocalStructuredSessionPresentation']>

  abstract captureStructuredAgentSessionPresentation(
    ...args: Parameters<ChatPresentation['captureStructuredAgentSessionPresentation']>
  ): ReturnType<ChatPresentation['captureStructuredAgentSessionPresentation']>

  abstract removeCapturedStructuredSessionSavedTabs(
    ...args: Parameters<ChatPresentation['removeCapturedStructuredSessionSavedTabs']>
  ): ReturnType<ChatPresentation['removeCapturedStructuredSessionSavedTabs']>

  declare browserTabClose: RuntimeEdgeCommandSurface['browserTabClose']

  async closeMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    options: MobileSessionTabCloseOptions = {}
  ): Promise<MobileSessionTabCloseOutcome> {
    const graphEpoch = options.clientNavigationId ? this.captureReadyGraphEpoch() : null
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorkspaceSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const observedPtyIds = await this.refreshMobileSessionPtyRecords()
    if (graphEpoch !== null) {
      this.assertStableReadyGraph(graphEpoch)
    }
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (options.reason !== undefined && options.reason !== 'user' && observedPtyIds === null) {
      // Keep-on-unknown must restore the mirror the caller already pruned.
      this.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('unknown-liveness', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    if (
      options.expectedPublicationEpoch !== undefined &&
      snapshot?.publicationEpoch !== options.expectedPublicationEpoch
    ) {
      this.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('stale-publication', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    const ptyCloseAuthority = options.expectedPtyCloseAuthority
      ? this.resolvePtyTabCloseSurfaceAuthority(options.expectedPtyCloseAuthority)
      : null
    const tab = options.expectedPtyCloseAuthority
      ? ptyCloseAuthority?.surface.tab
      : (snapshot?.tabs.find((candidate) => candidate.id === tabId) ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
        ) ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
        ))
    const lifecycleClose = resolveMobileSessionLifecycleCloseContext({
      host: this.getMobileSessionLifecycleCloseHost(),
      worktreeId,
      tabId,
      tab,
      authorityTab: ptyCloseAuthority?.surface.tab,
      snapshot,
      observedPtyIds
    })
    if (!snapshot || !tab) {
      return adjudicateAbsentMobileSessionTabClose({
        host: this.getMobileSessionLifecycleCloseHost(),
        context: lifecycleClose,
        worktreeId,
        snapshot,
        reason: options.reason,
        addressedByPtyCloseAuthority: options.expectedPtyCloseAuthority !== undefined
      })
    }
    if (options.expectedTerminalHandle !== undefined) {
      const terminalIncarnationMatches =
        tab.type === 'terminal' &&
        snapshot.tabs.some(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tab.parentTabId &&
            this.getMobileSessionTerminalHandle(worktreeId, candidate) ===
              options.expectedTerminalHandle
        )
      if (!terminalIncarnationMatches) {
        this.republishMobileSessionTabsSnapshot(worktreeId)
        return refusedMobileSessionTabClose('stale-terminal', {
          snapshotRepublished: true
        })
      }
    }
    let closedTabIds = [tab.id]
    const finishCommittedClose = (): MobileSessionTabCloseOutcome =>
      committedMobileSessionTabClose(this.clientSessionTabSelections, worktreeId, closedTabIds)
    if (tab.type === 'terminal') {
      // Wire parent::leaf names a pane; parent names its tab.
      const resolution = this.resolveTerminalCloseTarget(
        worktreeId,
        tab.id === tabId
          ? { kind: 'pane', tabId: tab.parentTabId, leafId: tab.leafId }
          : { kind: 'tab', tabId: tab.parentTabId }
      )
      const closingWholeParent = resolution === 'tab' || resolution === 'last-pane'
      if (closingWholeParent) {
        closedTabIds = snapshot.tabs.flatMap((candidate) =>
          candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
            ? [candidate.id, candidate.parentTabId]
            : []
        )
      }
      // Non-user lifecycle echoes cannot authorize killing any live parent PTY; refuse and republish for client resync.
      // Missing reason retains user-close behavior for legacy clients.
      if (options.reason !== undefined && options.reason !== 'user') {
        const leafHasConnectedPty = lifecycleClose.leafHasConnectedPty
        if (lifecycleClose.parentLeaves.some(leafHasConnectedPty)) {
          // Refuse dead-leaf echoes under live siblings, but do not republish the dead leaf or clients loop refuse/republish/echo.
          const addressedDeadLeaf = tab.id === tabId && !leafHasConnectedPty(tab)
          if (!addressedDeadLeaf) {
            this.republishMobileSessionTabsSnapshot(worktreeId)
          }
          // Skew-safe markers tell clients whether the host actually republished a mirror.
          return refusedMobileSessionTabClose('live-host-pty', {
            snapshotRepublished: !addressedDeadLeaf
          })
        }
        if (!closingWholeParent || this.tabs.has(tab.parentTabId)) {
          // Only the renderer may retire its own tab/split leaf; remote lifecycle echoes cannot authorize kills.
          return refusedMobileSessionTabClose('retirement-owner')
        }
      }
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        (await this.closeMobileRowInMainLayout(worktreeId, tabId, tab, options))
      ) {
        return finishCommittedClose()
      }
      // Headless parents need local kill/de-persist or relay acknowledgments resurrect them; renderer-owned parents retain its pin guard/durable close.
      if (closingWholeParent && !this.tabs.has(tab.parentTabId)) {
        await this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
          allowMissingPersistedTab: Boolean(ptyCloseAuthority),
          force: options.force,
          reason: options.reason,
          killPtys:
            options.localPtyTeardownOwnedExternally !== true &&
            (options.reason === undefined || options.reason === 'user'),
          ...(ptyCloseAuthority ? { authorizedPty: ptyCloseAuthority.pty } : {})
        })
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        return finishCommittedClose()
      }
      if (closingWholeParent && this.notifier?.closeTerminalTab) {
        // Commit the acknowledged identity even if renderer flush rebased its omission.
        const acknowledgeRetirement = this.captureTerminalTabRetirement(worktreeId, tab.parentTabId)
        // Await renderer pin guard, retirement and forced session flush.
        const win = this.getAvailableAuthoritativeWindow()
        if (win?.webContents.isDestroyed?.()) {
          throw new Error('runtime_unavailable')
        }
        const releasePublicationThrottle =
          options.clientNavigationId && win
            ? rendererPublicationThrottle.acquire(win.webContents)
            : () => {}
        try {
          await (options.localPtyTeardownOwnedExternally
            ? this.notifier.closeTerminalTab(tab.parentTabId, {
                localPtyTeardownOwnedExternally: true,
                ...(options.force ? { force: true } : {})
              })
            : options.force
              ? this.notifier.closeTerminalTab(tab.parentTabId, { force: true })
              : this.notifier.closeTerminalTab(tab.parentTabId))
        } finally {
          releasePublicationThrottle()
        }
        const remainingSnapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
        const retirement = acknowledgeRetirement()
        if (!retirement.matches) {
          this.republishMobileSessionTabsSnapshot(worktreeId)
          return refusedMobileSessionTabClose('stale-terminal', { snapshotRepublished: true })
        }
        const remainingTab = remainingSnapshot?.tabs.find(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
        )
        if (
          remainingSnapshot &&
          remainingTab &&
          this.isRuntimeOwnedHeadlessMobileTab(worktreeId, remainingTab)
        ) {
          const remainingPtyCloseAuthority = options.expectedPtyCloseAuthority
            ? this.resolvePtyTabCloseSurfaceAuthority(options.expectedPtyCloseAuthority)
            : null
          // Relay recovery may acknowledge an absent renderer tab; HUB still retires its SSH surface.
          await this.closeHeadlessMobileTerminalTab(worktreeId, remainingSnapshot, remainingTab, {
            // The renderer may already have durably removed it.
            allowMissingPersistedTab: true,
            force: options.force,
            ...(remainingPtyCloseAuthority ? { authorizedPty: remainingPtyCloseAuthority.pty } : {})
          })
          this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        } else if (retirement.hasPersistedTab) {
          // Cover acknowledged tabs absent from renderer inventory; concurrent durable removal is idempotent.
          await this.closeTerminalSurface(
            worktreeId,
            { kind: 'tab', tabId: tab.parentTabId },
            { allowMissing: true, force: options.force }
          )
        }
        if (!acknowledgeRetirement().matches) {
          this.republishMobileSessionTabsSnapshot(worktreeId)
          return refusedMobileSessionTabClose('stale-terminal', { snapshotRepublished: true })
        }
        this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
        return finishCommittedClose()
      }
      if (closingWholeParent) {
        // Notifiers without acknowledged relay may offer raw close only; runtime parents still need kill and de-persist.
        if (
          !this.notifier?.closeTerminal ||
          this.isRuntimeOwnedHeadlessMobileTab(worktreeId, tab)
        ) {
          await this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
            force: options.force,
            ...(ptyCloseAuthority ? { authorizedPty: ptyCloseAuthority.pty } : {})
          })
          this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
          return finishCommittedClose()
        }
        this.notifier.closeTerminal(tab.parentTabId)
        this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
        return delegatedMobileSessionTabClose()
      }
      await this.closeMobileSessionTerminalPane(worktreeId, tab)
      return finishCommittedClose()
    } else if (tab.type === 'browser') {
      // Client-hosted, offscreen and renderer browser pages each own their retirement path.
      const clientPage = tab.browserPageId
        ? getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
        : undefined
      if (clientPage) {
        await this.browserTabClose({
          worktree: `id:${worktreeId}`,
          page: clientPage.browserPageId
        })
      } else if (this.isOffscreenMobileSessionBrowserTab(snapshot, tab)) {
        await this.offscreenBrowserBackend!.closeTab(tab.browserPageId!).catch(() => {})
        this.retireRuntimeOwnedBrowserSessionTab(worktreeId, tab.browserPageId!)
      } else {
        if (!this.notifier?.closeSessionTab) {
          throw new Error('runtime_unavailable')
        }
        await this.notifier.closeSessionTab(tab.id, worktreeId)
      }
    } else if (tab.type === 'agent-session') {
      const committed = await closeMobileStructuredSessionPresentation({
        tab,
        worktreeId,
        reason: options.reason,
        local: () => this.workspaceSessions.tryGetHostId(worktreeId) === LOCAL_EXECUTION_HOST_ID,
        rows: () => this.mobileSessionTabsByWorktree.get(worktreeId)?.tabs,
        notifier: this.notifier,
        runtime: this
      })
      if (!committed) {
        return delegatedMobileSessionTabClose()
      }
    } else if (!this.notifier?.closeSessionTab) {
      // Headless editors retire through the host-owned session.
      if (!retireHeadlessMobileSessionEditorTab(this, worktreeId, tab, options.force)) {
        throw new Error('runtime_unavailable')
      }
    } else {
      await this.notifier.closeSessionTab(tab.id, worktreeId)
    }
    return finishCommittedClose()
  }

  protected getMobileSessionLifecycleCloseHost(): MobileSessionLifecycleCloseHost {
    return {
      tabs: this.tabs,
      leaves: this.leaves,
      ptysById: this.ptysById,
      findPtyForMobileTerminalTab: this.findPtyForMobileTerminalTab.bind(this),
      republishSnapshot: (worktreeId) => this.republishMobileSessionTabsSnapshot(worktreeId)
    }
  }
}
