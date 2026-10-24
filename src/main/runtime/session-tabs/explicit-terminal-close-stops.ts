import { windowListsTab } from '../terminal/surface/main-terminal-surfaces'
import { isOriginalTerminalHandle } from '../workspace-session-terminal-tab-retirement-identity'
import { NO_STOP } from './explicit-terminal-close-pty-stops'
import {
  matchesTerminalSurfaceCapture,
  type TerminalSurfaceCloseCapture
} from '../../../shared/terminal-tab-close'
import type { WorktreePtyHostFence } from '../worktree-pty-host-fence'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from '../runtime-terminal-state-records'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import { closeMainOwnedPaneByHandle } from './main-handle-close'
import { OrcaRuntimeWithExplicitTerminalTabClose } from './explicit-terminal-tab-close'
import {
  closeTerminalOnPairedHost,
  getPairedHostTerminal,
  isTerminalTabPinnedInSession
} from './paired-host-terminal-close'

export abstract class OrcaRuntimeWithStopExplicitlyClosedTabPtys extends OrcaRuntimeWithExplicitTerminalTabClose {
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>
  protected abstract refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId?: string | null,
    deadline?: number
  ): Promise<Set<string> | null>
  protected abstract getLivePtyIdsForWorktree(
    worktreeId: string,
    freshPtyIds?: ReadonlySet<string>,
    hostFence?: WorktreePtyHostFence
  ): Set<string>
  protected abstract getTerminalHandlesForPtyId(ptyId: string): string[]
  protected abstract getRecordedTerminalSleepHandles(
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ): string[]
  protected abstract commitWorktreeTerminalSleepPtys(args: {
    worktreeId: string
    generation: number
    ptyIds: readonly string[]
    pendingPtyIds: Set<string>
    committedPtyIds: Set<string>
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  }): void

  async closeTerminal(
    handle: string,
    incarnation?: string,
    originalPresentation?: TerminalSurfaceCloseCapture
  ): Promise<RuntimeTerminalClose> {
    const pty = this.getLivePtyForHandle(handle)
    if (originalPresentation) {
      const remote = getPairedHostTerminal(pty?.pty.ptyId ?? this.handles.get(handle)?.ptyId)
      if (remote) {
        const leaf = this.getLiveLeafForHandle(handle).leaf
        const pane = { kind: 'pane' as const, tabId: leaf.tabId, leafId: leaf.leafId }
        if (
          this.resolveTerminalCloseTarget(leaf.worktreeId, pane) === 'last-pane' &&
          this.getWorkspaceSessionHostIdsForTab(leaf.worktreeId, leaf.tabId).some((id) =>
            isTerminalTabPinnedInSession(this.store?.getWorkspaceSession?.(id), leaf)
          )
        ) {
          throw new Error('terminal_tab_pinned')
        }
        const close = await closeTerminalOnPairedHost(
          (...args) => this.callOrchestrationWorkerServer(...args),
          remote,
          'terminal.close',
          { expectedIncarnationId: incarnation, originalPresentation }
        )
        return { handle, tabId: leaf.tabId, ...close }
      }
      const source = originalPresentation.identity
      const record = this.handles.get(handle)
      const currentPty = source.ptyId ? this.ptysById.get(source.ptyId) : null
      const leaf = this.leaves.get(this.getLeafKey(source.tabId, source.leafId))
      if (
        !source.ptyId ||
        !incarnation ||
        !isOriginalTerminalHandle({
          runtimeId: this.runtimeId,
          record,
          currentPty,
          paneOfPty: (current) => this.paneOfPty(current),
          leaf,
          source,
          incarnation
        }) ||
        !matchesTerminalSurfaceCapture(
          originalPresentation,
          this.getWorkspaceSessionHostIdsForTab(source.worktreeId, source.tabId),
          (hostId) => this.store?.getWorkspaceSession?.(hostId)
        )
      ) {
        throw new Error('terminal_handle_stale')
      }
      const target = { kind: 'pane' as const, tabId: source.tabId, leafId: source.leafId }
      const rendererOwnsPresentation = windowListsTab(this, this.tabs, source.tabId)
      const proof = {
        parentTabId: source.tabId,
        leafId: source.leafId,
        ptyId: source.ptyId,
        terminal: handle,
        incarnationId: incarnation
      }
      if (
        this.resolveTerminalCloseTarget(source.worktreeId, target) === 'last-pane' &&
        this.getWorkspaceSessionHostIdsForTab(source.worktreeId, source.tabId).some((hostId) =>
          isTerminalTabPinnedInSession(this.store?.getWorkspaceSession?.(hostId), source)
        )
      ) {
        throw new Error('terminal_tab_pinned')
      }
      const stop = await this.stopExplicitlyClosedTabPtys([source.ptyId], source.ptyId, incarnation)
      if (!stop.stopped) {
        throw new Error('terminal_close_unverifiable')
      }
      const outcome = await this.closeMobileSessionTab(`id:${source.worktreeId}`, source.tabId, {
        originalPresentation,
        rendererOwnsPresentation,
        localPtyTeardownOwnedExternally: true,
        retirementProofs: [proof]
      })
      if (outcome.refused) {
        throw new Error('terminal_pane_close_failed')
      }
      this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
      return this.describeTerminalClose(handle, source.tabId, source.ptyId, stop)
    }
    if (incarnation && pty?.pty.incarnationId !== incarnation) {
      throw new Error('terminal_handle_stale')
    }
    const stopCurrent = (ids: readonly string[], addressed: string) =>
      this.stopExplicitlyClosedTabPtys(ids, addressed)
    // Switch point: a pane main owns closes in main's layout, whatever the window lists.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const mainClose = await closeMainOwnedPaneByHandle(
        {
          runtime: this,
          livePty: () => this.getLivePtyForHandle(handle)?.pty ?? null,
          liveLeaf: () => this.getLiveLeafForHandle(handle).leaf,
          remoteSessionIdOf: (worktreeId, tabId) =>
            this.getWorkspaceSessionForWorktree(worktreeId)?.remoteSessionIdsByTabId?.[tabId],
          applyLayoutCommand: (command) => this.applyLayoutCommand(command),
          stop: stopCurrent,
          describe: (...args) => this.describeTerminalClose(...args)
        },
        handle,
        false
      )
      if (mainClose) {
        this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
        return mainClose
      }
    }
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
      // Why: PTY exit can immediately replace a ready SSH publication with a pending one, so capture its durable HUB surface before killing it.
      const surface =
        ptyCloseAuthority?.surface ??
        (spawnSurface && this.getMobileTerminalLeafPtyIds(spawnSurface.tab).length === 0
          ? spawnSurface
          : null)
      const tabId = surface?.tab.parentTabId ?? recorded.tabId ?? pty.record.tabId
      const leafId = surface?.tab.leafId ?? parsePaneKey(recorded.paneKey ?? '')?.leafId
      const paneTarget = leafId ? { kind: 'pane' as const, tabId, leafId } : null
      // Why: a PTY with no pane identity cannot be placed in any tab's layout, so it closes nothing.
      const closesTab =
        paneTarget !== null &&
        this.resolveTerminalCloseTarget(pty.pty.worktreeId, paneTarget) === 'last-pane'
      if (closesTab && surface && this.tabs.has(tabId) && this.notifier?.closeTerminalTab) {
        const ptyIdsToKill = this.getPtyIdsForExplicitTabClose(pty.pty.worktreeId, tabId)
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
        const stop = await stopCurrent(ptyIdsToKill, pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
      }
      if (closesTab && surface && ptyCloseAuthority && !this.tabs.has(surface.tab.parentTabId)) {
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
          const stop = await stopCurrent([pty.pty.ptyId], pty.pty.ptyId)
          this.notifyRendererOfHeadlessTerminalClose(tabId)
          return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
        }
        const stop = await stopCurrent([pty.pty.ptyId], pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
      }
      // Why the tabs guard: a headless host has no renderer tab to close through the notifier.
      if (
        closesTab &&
        !surface &&
        recorded.tabId &&
        this.tabs.has(tabId) &&
        this.notifier?.closeTerminalTab
      ) {
        const ptyIdsToKill = this.getPtyIdsForExplicitTabClose(pty.pty.worktreeId, tabId)
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
          const stop = await stopCurrent(ptyIdsToKill, pty.pty.ptyId)
          return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
        }
      }
      const stop = await stopCurrent([pty.pty.ptyId], pty.pty.ptyId)
      if (!closesTab) {
        // Why: the pane's removal is this close's own commit, not a side effect of its exit. An
        // unconfirmed stop is unverifiable, never a reason to close the live siblings with it.
        if (paneTarget) {
          await this.closeTerminalPane(pty.pty.worktreeId, paneTarget)
        }
      } else if (surface) {
        // Why: paired viewers keep ended streams mounted until the HUB publishes removal, so explicit close uses the durable host-tab transaction instead of viewer-local exit handling.
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
    const ptyIdsToKill = closesTab
      ? this.getPtyIdsForExplicitTabClose(leaf.worktreeId, leaf.tabId)
      : leaf.ptyId
        ? [leaf.ptyId]
        : []
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
    const stop = leaf.ptyId ? await stopCurrent(ptyIdsToKill, leaf.ptyId) : NO_STOP
    if (!closesTab) {
      await this.closeTerminalPane(leaf.worktreeId, paneTarget)
    } else if (!this.notifier?.closeTerminalTab) {
      this.notifier?.closeTerminal(leaf.tabId)
    }
    return this.describeTerminalClose(handle, leaf.tabId, leaf.ptyId ?? null, stop)
  }
}
