// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose } from './orca-runtime-refuse-unattributed-mobile-session-tab-close'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeSessionTabCloseReason
} from '../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from './runtime-terminal-state-records'
import {
  adjudicateAbsentMobileSessionTabClose,
  resolveMobileSessionLifecycleCloseContext,
  type MobileSessionLifecycleCloseHost
} from './mobile-session-lifecycle-close-adjudication'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import {
  committedMobileSessionTabClose,
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose
} from './mobile-session-tab-close-outcome'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { SESSION_TAB_NOT_FOUND_ERROR } from '../../shared/session-tab-close'

export class OrcaRuntimeWithCloseMobileSessionTab extends OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose {
  async closeMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    options: {
      reason?: RuntimeSessionTabCloseReason
      expectedPublicationEpoch?: string
      expectedTerminalHandle?: string
      clientNavigationId?: string
      localPtyTeardownOwnedExternally?: boolean
      expectedPtyCloseAuthority?: RuntimePtyTabCloseAuthority
      force?: boolean
    } = {}
  ): Promise<MobileSessionTabCloseOutcome> {
    const graphEpoch = options.clientNavigationId ? this.captureReadyGraphEpoch() : null
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const observedPtyIds = await this.refreshMobileSessionPtyRecords()
    if (graphEpoch !== null) {
      this.assertStableReadyGraph(graphEpoch)
    }
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (options.reason !== undefined && options.reason !== 'user' && observedPtyIds === null) {
      // Why: keep-on-unknown must also restore the mirror the caller already pruned.
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
    let closedSelectionTabIds = [tab.id]
    const finishCommittedClose = (): MobileSessionTabCloseOutcome =>
      committedMobileSessionTabClose(
        this.clientSessionTabSelections,
        worktreeId,
        closedSelectionTabIds
      )
    if (tab.type === 'terminal') {
      const parentLeafCount = snapshot.tabs.filter(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
      ).length
      const closingWholeParent = tab.id !== tabId || parentLeafCount <= 1
      if (closingWholeParent) {
        closedSelectionTabIds = snapshot.tabs.flatMap((candidate) =>
          candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
            ? [candidate.id, candidate.parentTabId]
            : []
        )
      }
      // Why: a non-'user' reason is a client-lifecycle echo ("terminal gone"),
      // not authorization to kill. Every destructive branch below can take the
      // whole parent down, so any live PTY under the parent means the echo is a
      // transport artifact: refuse the close and republish the snapshot so the
      // echoing client re-syncs and re-attaches. A reasonless close keeps
      // legacy behavior — old clients send user closes without the field.
      if (options.reason !== undefined && options.reason !== 'user') {
        const leafHasConnectedPty = lifecycleClose.leafHasConnectedPty
        if (lifecycleClose.parentLeaves.some(leafHasConnectedPty)) {
          // Why: when the echo addresses a dead leaf under a live sibling we
          // still refuse (every reachable close path below destroys the whole
          // parent, live sibling included) but skip the republish — re-adding
          // the dead leaf on the echoing client would feed an endless
          // refuse→republish→re-echo cycle.
          const addressedDeadLeaf = tab.id === tabId && !leafHasConnectedPty(tab)
          if (!addressedDeadLeaf) {
            this.republishMobileSessionTabsSnapshot(worktreeId)
          }
          // Why: both markers are skew-safe; clients must restore a mirror only
          // when the host actually republished it, not for a dead leaf.
          return refusedMobileSessionTabClose('live-host-pty', {
            snapshotRepublished: !addressedDeadLeaf
          })
        }
        if (!closingWholeParent || this.tabs.has(tab.parentTabId)) {
          // Why: only the renderer may retire its own tab or split leaf; a
          // remote lifecycle echo must never cross that boundary into a kill.
          return refusedMobileSessionTabClose('retirement-owner')
        }
      }
      // Why: a runtime-owned headless tab is absent from renderer state, so the
      // closeTerminalTab relay below would ack success without killing its PTY,
      // and syncMobileSessionTabs would republish the "closed" tab. Only bypass
      // the relay when no renderer owns the parent: an adopted tab needs the
      // renderer's live pin guard and durable close transaction.
      if (closingWholeParent && !this.tabs.has(tab.parentTabId)) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
          allowMissingPersistedTab: Boolean(ptyCloseAuthority),
          force: options.force,
          killPtys:
            options.localPtyTeardownOwnedExternally !== true &&
            (options.reason === undefined || options.reason === 'user'),
          ...(ptyCloseAuthority ? { authorizedPty: ptyCloseAuthority.pty } : {})
        })
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        return finishCommittedClose()
      }
      if (closingWholeParent && this.notifier?.closeTerminalTab) {
        // Why: whole-tab close is a lifecycle transaction. The renderer reply
        // arrives only after canonical retirement and a forced session flush.
        const win = this.getAvailableAuthoritativeWindow()
        if (win?.webContents.isDestroyed?.()) {
          throw new Error('runtime_unavailable')
        }
        const releasePublicationThrottle =
          options.clientNavigationId && win
            ? this.rendererPublicationThrottle.acquire(win.webContents)
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
          // Why: after relay recovery the renderer can acknowledge a tab it no longer mirrors; the HUB must still retire its SSH-owned surface.
          this.closeHeadlessMobileTerminalTab(worktreeId, remainingSnapshot, remainingTab, {
            // Why: the renderer may already have durably removed the tab before acknowledging.
            allowMissingPersistedTab: true,
            force: options.force,
            ...(remainingPtyCloseAuthority ? { authorizedPty: remainingPtyCloseAuthority.pty } : {})
          })
          this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        }
        this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
        return finishCommittedClose()
      }
      // Why: notifier implementations without the acknowledged relay may expose
      // only raw pane close. Runtime-owned parents still need de-persist + kill.
      if (closingWholeParent && this.isRuntimeOwnedHeadlessMobileTab(worktreeId, tab)) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
          force: options.force,
          ...(ptyCloseAuthority ? { authorizedPty: ptyCloseAuthority.pty } : {})
        })
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        return finishCommittedClose()
      }
      if (!this.notifier?.closeTerminal) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
          force: options.force,
          ...(ptyCloseAuthority ? { authorizedPty: ptyCloseAuthority.pty } : {})
        })
        return finishCommittedClose()
      }
      if (tab.id === tabId) {
        const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
        if (pty) {
          if (this.ptyController?.kill(pty.ptyId) !== true) {
            throw new Error('terminal_close_failed')
          }
          return finishCommittedClose()
        }
        this.notifier.closeTerminal(tab.parentTabId)
        return delegatedMobileSessionTabClose()
      }
      // Why: paired web tab bars represent a split terminal with one local
      // parent tab id. Closing that parent should close the desktop tab, not
      // just whichever leaf happened to be first in the session snapshot.
      this.notifier.closeTerminal(tab.parentTabId)
      this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
      return delegatedMobileSessionTabClose()
    } else if (tab.type === 'browser') {
      // Why: a browser tab can be hosted by a client, by the offscreen backend,
      // or by the renderer; each surface owns a different retirement path.
      const clientPage = tab.browserPageId
        ? getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
        : undefined
      if (clientPage) {
        await (this as RuntimeCommandSurfaceHost<this>).browserTabClose({
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
      if (this.notifier?.closeSessionTab) {
        try {
          await this.notifier.closeSessionTab(
            structuredAgentSessionTabId(tab.sessionId),
            worktreeId
          )
        } catch (error) {
          // The renderer already having removed the tab is an idempotent close, not a veto.
          if (!(error instanceof Error && error.message === SESSION_TAB_NOT_FOUND_ERROR)) {
            throw error
          }
        }
      }
      await this.closeStructuredAgentSessionTab(worktreeId, snapshot, tab)
    } else {
      if (!this.notifier?.closeSessionTab) {
        throw new Error('runtime_unavailable')
      }
      await this.notifier.closeSessionTab(tab.id, worktreeId)
    }
    return finishCommittedClose()
  }

  protected getMobileSessionLifecycleCloseHost(): MobileSessionLifecycleCloseHost {
    return {
      tabs: this.tabs,
      leaves: this.leaves,
      ptysById: this.ptysById,
      findPtyForMobileTerminalTab: (worktreeId, tab) =>
        this.findPtyForMobileTerminalTab(worktreeId, tab),
      republishSnapshot: (worktreeId) => this.republishMobileSessionTabsSnapshot(worktreeId)
    }
  }
}
