import { windowListsTab } from '../terminal/surface/main-terminal-surfaces'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from '../runtime-terminal-state-records'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import { closeMainOwnedPaneByHandle } from './main-handle-close'
import {
  NO_STOP,
  OrcaRuntimeWithExplicitCloseTabPtyStops
} from './explicit-terminal-close-pty-stops'
import {
  closePairedHostLeafFirst,
  isTerminalTabPinnedInSession
} from './paired-host-terminal-close'

export abstract class OrcaRuntimeWithStopExplicitlyClosedTabPtys extends OrcaRuntimeWithExplicitCloseTabPtyStops {
  abstract applyLayoutCommand(
    command: WindowLayoutCommand,
    run?: Pick<LayoutCommandRunOptions, 'admit'>
  ): Promise<LayoutApplyReply>
  /** null when this machine owns the PTY; see `closePairedHostLeafFirst` otherwise. */
  private closeOnOwningPairedHost(
    handle: string,
    leaf: { worktreeId: string; tabId: string; leafId: string; ptyId: string | null },
    method: 'terminal.close' | 'terminal.closeTab',
    closesTab: boolean
  ): ReturnType<typeof closePairedHostLeafFirst> {
    return closePairedHostLeafFirst(leaf, method, {
      call: (environmentId, hostMethod, params, timeoutMs) =>
        this.callOrchestrationWorkerServer(environmentId, hostMethod, params, timeoutMs),
      isTabPinned: () =>
        closesTab &&
        this.getWorkspaceSessionHostIdsForTab(leaf.worktreeId, leaf.tabId).some((hostId) =>
          isTerminalTabPinnedInSession(this.store?.getWorkspaceSession?.(hostId), leaf)
        ),
      readBoundLeaf: () => this.getLiveLeafForHandle(handle).leaf
    })
  }

  async closeTerminal(handle: string): Promise<RuntimeTerminalClose> {
    const mainClose = await closeMainOwnedPaneByHandle(
      {
        runtime: this,
        livePty: () => this.getLivePtyForHandle(handle)?.pty ?? null,
        liveLeaf: () => this.getLiveLeafForHandle(handle).leaf,
        remoteSessionIdOf: (worktreeId, tabId) =>
          this.getWorkspaceSessionForWorktree(worktreeId)?.remoteSessionIdsByTabId?.[tabId],
        applyLayoutCommand: (command) => this.applyLayoutCommand(command),
        capture: (ptyIds, scope) => this.captureExplicitCloseTargets(ptyIds, scope),
        stop: (ptyIds, addressed) => this.stopExplicitlyClosedTabPtys(ptyIds, addressed),
        describe: (...args) => this.describeTerminalClose(...args)
      },
      handle,
      false
    )
    if (mainClose) {
      this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
      return mainClose
    }
    const pty = this.getLivePtyForHandle(handle)
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
    if (pty) {
      const closeAuthority: RuntimePtyTabCloseAuthority = {
        handle,
        ptyId: pty.pty.ptyId,
        incarnationId: pty.pty.incarnationId,
        worktreeId: pty.pty.worktreeId
      }
      const ptyCloseAuthority = this.resolvePtyTabCloseSurfaceAuthority(closeAuthority)
      const recorded = this.paneOfPty(pty.pty)
      const spawnSurface = recorded.tabId
        ? this.findMobileTerminalSurface(pty.pty.worktreeId, recorded.tabId)
        : null
      // Capture durable HUB identity before kill: PTY exit may immediately turn a ready SSH publication pending.
      const surface =
        ptyCloseAuthority?.surface ??
        (spawnSurface && this.getMobileTerminalLeafPtyIds(spawnSurface.tab).length === 0
          ? spawnSurface
          : null)
      const tabId = surface?.tab.parentTabId ?? recorded.tabId ?? pty.record.tabId
      const leafId = surface?.tab.leafId ?? parsePaneKey(recorded.paneKey ?? '')?.leafId
      const paneTarget = leafId ? { kind: 'pane' as const, tabId, leafId } : null
      // Without pane identity, a PTY cannot authorize closing any tab layout.
      const closesTab =
        paneTarget !== null &&
        this.resolveTerminalCloseTarget(pty.pty.worktreeId, paneTarget) === 'last-pane'
      const capturedPty = this.captureExplicitCloseTargets([pty.pty.ptyId], {
        worktreeId: pty.pty.worktreeId,
        tabId,
        ...(closesTab ? {} : { leafId })
      })
      if (
        closesTab &&
        surface &&
        windowListsTab(this, this.tabs, tabId) &&
        this.notifier?.closeTerminalTab
      ) {
        const ptyIdsToKill = this.captureExplicitCloseTargets(
          this.getPtyIdsForExplicitTabClose(pty.pty.worktreeId, tabId),
          { worktreeId: pty.pty.worktreeId, tabId }
        )
        try {
          await this.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, {
            localPtyTeardownOwnedExternally: true
          })
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
            throw error
          }
          this.notifyRendererOfHeadlessTerminalClose(tabId)
        }
        const stop = await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
      }
      if (
        closesTab &&
        surface &&
        ptyCloseAuthority &&
        !windowListsTab(this, this.tabs, surface.tab.parentTabId)
      ) {
        try {
          await this.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, {
            reason: 'user',
            localPtyTeardownOwnedExternally: true,
            expectedPtyCloseAuthority: closeAuthority
          })
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
            throw error
          }
          const stop = await this.stopExplicitlyClosedTabPtys(capturedPty, pty.pty.ptyId)
          this.notifyRendererOfHeadlessTerminalClose(tabId)
          return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
        }
        const stop = await this.stopExplicitlyClosedTabPtys(capturedPty, pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
      }
      // Headless hosts have no renderer tab to close through the notifier.
      if (
        closesTab &&
        !surface &&
        recorded.tabId &&
        windowListsTab(this, this.tabs, tabId) &&
        this.notifier?.closeTerminalTab
      ) {
        const ptyIdsToKill = this.captureExplicitCloseTargets(
          this.getPtyIdsForExplicitTabClose(pty.pty.worktreeId, tabId),
          { worktreeId: pty.pty.worktreeId, tabId }
        )
        let tabClosed = true
        try {
          await this.notifier.closeTerminalTab(tabId, { localPtyTeardownOwnedExternally: true })
        } catch (error) {
          // The tab went away concurrently; fall through and close the PTY alone.
          if (!(error instanceof Error) || error.message !== 'tab_not_found') {
            throw error
          }
          tabClosed = false
        }
        if (tabClosed) {
          const stop = await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, pty.pty.ptyId)
          return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
        }
      }
      const stop = await this.stopExplicitlyClosedTabPtys(capturedPty, pty.pty.ptyId)
      if (!closesTab) {
        // Commit this pane's removal explicitly; unconfirmed stop never authorizes closing live siblings.
        if (paneTarget) {
          await this.closeTerminalPane(pty.pty.worktreeId, paneTarget)
        }
      } else if (surface) {
        // Paired viewers retain ended streams until HUB removal; use durable host close instead of viewer-local exit handling.
        try {
          await this.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, {
            localPtyTeardownOwnedExternally: true
          })
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
            throw error
          }
          this.notifyRendererOfHeadlessTerminalClose(tabId)
        }
      } else {
        this.notifyRendererOfHeadlessTerminalClose(tabId)
      }
      return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const paneTarget = { kind: 'pane' as const, tabId: leaf.tabId, leafId: leaf.leafId }
    const hostClose = await this.closeOnOwningPairedHost(
      handle,
      leaf,
      'terminal.close',
      this.resolveTerminalCloseTarget(leaf.worktreeId, paneTarget) === 'last-pane'
    )
    if (hostClose && !hostClose.stillBound) {
      return { handle, tabId: leaf.tabId, ...hostClose.close }
    }
    const closesTab = this.resolveTerminalCloseTarget(leaf.worktreeId, paneTarget) === 'last-pane'
    const ptyIdsToKill = this.captureExplicitCloseTargets(
      closesTab
        ? this.getPtyIdsForExplicitTabClose(leaf.worktreeId, leaf.tabId)
        : leaf.ptyId
          ? [leaf.ptyId]
          : [],
      {
        worktreeId: leaf.worktreeId,
        tabId: leaf.tabId,
        ...(closesTab ? {} : { leafId: leaf.leafId })
      }
    )
    if (closesTab && this.notifier?.closeTerminalTab) {
      await this.notifier.closeTerminalTab(leaf.tabId, { localPtyTeardownOwnedExternally: true })
    }
    if (hostClose) {
      if (!closesTab) {
        await this.closeTerminalPane(leaf.worktreeId, paneTarget)
      } else if (!this.notifier?.closeTerminalTab) {
        this.notifier?.closeTerminal(leaf.tabId)
      }
      return { handle, tabId: leaf.tabId, ...hostClose.close }
    }
    const stop = leaf.ptyId
      ? await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, leaf.ptyId)
      : NO_STOP
    if (!closesTab) {
      await this.closeTerminalPane(leaf.worktreeId, paneTarget)
    } else if (!this.notifier?.closeTerminalTab) {
      this.notifier?.closeTerminal(leaf.tabId)
    }
    return this.describeTerminalClose(handle, leaf.tabId, leaf.ptyId ?? null, stop)
  }

  async closeTerminalTab(handle: string): Promise<RuntimeTerminalClose> {
    const mainClose = await closeMainOwnedPaneByHandle(
      {
        runtime: this,
        livePty: () => this.getLivePtyForHandle(handle)?.pty ?? null,
        liveLeaf: () => this.getLiveLeafForHandle(handle).leaf,
        remoteSessionIdOf: (worktreeId, tabId) =>
          this.getWorkspaceSessionForWorktree(worktreeId)?.remoteSessionIdsByTabId?.[tabId],
        applyLayoutCommand: (command) => this.applyLayoutCommand(command),
        capture: (ptyIds, scope) => this.captureExplicitCloseTargets(ptyIds, scope),
        stop: (ptyIds, addressed) => this.stopExplicitlyClosedTabPtys(ptyIds, addressed),
        describe: (...args) => this.describeTerminalClose(...args)
      },
      handle,
      true
    )
    if (mainClose) {
      this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
      return mainClose
    }
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const closeAuthority: RuntimePtyTabCloseAuthority = {
        handle,
        ptyId: pty.pty.ptyId,
        incarnationId: pty.pty.incarnationId,
        worktreeId: pty.pty.worktreeId
      }
      const tabId =
        this.resolvePtyTabCloseSurfaceAuthority(closeAuthority)?.surface.tab.parentTabId ??
        this.paneOfPty(pty.pty).tabId
      if (!tabId) {
        return this.closeTerminal(handle)
      }
      // Handle-addressed CLI/automation close is user intent under lifecycle-echo adjudication.
      await this.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, {
        reason: 'user',
        expectedPtyCloseAuthority: closeAuthority
      })
      this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
      return { handle, tabId, closeMode: 'tab', ptyKilled: false }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const hostClose = await this.closeOnOwningPairedHost(handle, leaf, 'terminal.closeTab', true)
    if (hostClose && !hostClose.stillBound) {
      return { handle, tabId: leaf.tabId, ...hostClose.close, closeMode: 'tab' }
    }
    await this.closeMobileSessionTab(`id:${leaf.worktreeId}`, leaf.tabId, { reason: 'user' })
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
    return { handle, tabId: leaf.tabId, ptyKilled: false, ...hostClose?.close, closeMode: 'tab' }
  }
}
