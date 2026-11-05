import type { TerminalCloseRunOptions } from '../terminal-surface-close'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from '../runtime-terminal-state-records'
import { capturePersistedTerminalTabCopy } from '../workspace-session-terminal-tab-retirement-identity'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import { closeMainOwnedPaneByHandle } from './main-handle-close'
import {
  NO_STOP,
  OrcaRuntimeWithExplicitCloseTabPtyStops
} from './explicit-terminal-close-pty-stops'

export abstract class OrcaRuntimeWithExplicitTerminalPaneClose extends OrcaRuntimeWithExplicitCloseTabPtyStops {
  abstract applyLayoutCommand(
    command: WindowLayoutCommand,
    run?: TerminalCloseRunOptions
  ): Promise<LayoutApplyReply>

  async closeTerminal(
    handle: string,
    options: { beforeAction?: () => void } = {}
  ): Promise<RuntimeTerminalClose> {
    options.beforeAction?.()
    let committed = false
    const beforeAction = options.beforeAction
      ? () => {
          if (!committed) {
            options.beforeAction?.()
          }
          // After the first irreversible close, its stop belongs to that same committed action.
          committed = true
        }
      : undefined
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const mainClose = await closeMainOwnedPaneByHandle(
        {
          runtime: this,
          livePty: () => this.getLivePtyForHandle(handle)?.pty ?? null,
          liveLeaf: () => this.getLiveLeafForHandle(handle).leaf,
          remoteSessionIdOf: (worktreeId, tabId) =>
            this.getWorkspaceSessionForWorktree(worktreeId)?.remoteSessionIdsByTabId?.[tabId],
          applyLayoutCommand: (command) => this.applyLayoutCommand(command, beforeAction),
          stop: (ptyIds, addressed) =>
            this.stopExplicitlyClosedTabPtys(ptyIds, addressed, beforeAction),
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
      if (
        closesTab &&
        surface &&
        paneTarget &&
        (!this.tabs.has(tabId) || this.notifier?.closeTerminalTab)
      ) {
        const retirement = this.captureTerminalTabRetirement(closeAuthority.worktreeId, tabId)
        const holders = this.getWorkspaceSessionHostIdsForTab(closeAuthority.worktreeId, tabId)
        const savedCopies = holders.map((hostId) =>
          capturePersistedTerminalTabCopy(
            this.store?.getWorkspaceSession?.(hostId),
            closeAuthority.worktreeId,
            tabId
          )
        )
        const ptyIdsToKill = this.tabs.has(tabId)
          ? this.getPtyIdsForExplicitTabClose(closeAuthority.worktreeId, tabId)
          : [closeAuthority.ptyId]
        const incarnations = new Map(
          ptyIdsToKill.map((id) => [id, this.ptysById.get(id)?.incarnationId])
        )
        const admitClose = () => {
          if (committed) {
            return
          }
          const live = this.getLivePtyForHandle(handle)
          const current = this.findMobileTerminalSurface(closeAuthority.worktreeId, tabId)
          const owner = retirement()
          const savedContradiction = savedCopies.some(
            (copy) =>
              copy &&
              ((copy.ptyId !== null && copy.ptyId !== closeAuthority.ptyId) ||
                [...copy.leaves].some(
                  ([id, binding]) =>
                    id !== paneTarget.leafId ||
                    (binding.ptyId !== null && binding.ptyId !== closeAuthority.ptyId) ||
                    (binding.incarnationId !== null &&
                      binding.incarnationId !== closeAuthority.incarnationId)
                ))
          )
          if (
            !live ||
            live.pty.ptyId !== closeAuthority.ptyId ||
            live.pty.incarnationId !== closeAuthority.incarnationId ||
            live.pty.worktreeId !== closeAuthority.worktreeId ||
            live.record.worktreeId !== closeAuthority.worktreeId ||
            !owner.matches ||
            !current ||
            current.tab.parentTabId !== tabId ||
            current.tab.leafId !== paneTarget.leafId ||
            (ptyCloseAuthority &&
              (() => {
                const authority = this.resolvePtyTabCloseSurfaceAuthority(closeAuthority)
                return (
                  !authority ||
                  authority.surface.tab.parentTabId !== tabId ||
                  authority.surface.tab.leafId !== paneTarget.leafId
                )
              })()) ||
            this.resolveTerminalCloseTarget(closeAuthority.worktreeId, paneTarget) !==
              'last-pane' ||
            (!ptyCloseAuthority &&
              (!owner.hasPersistedTab ||
                this.getMobileSessionTerminalHandle(closeAuthority.worktreeId, current.tab) !==
                  handle ||
                savedContradiction ||
                !savedCopies.some((copy) => copy?.leaves.has(paneTarget.leafId)) ||
                recorded.tabId !== tabId ||
                parsePaneKey(recorded.paneKey ?? '')?.leafId !== paneTarget.leafId ||
                this.paneOfPty(live.pty).paneKey !== recorded.paneKey ||
                this.getMobileTerminalLeafPtyIds(current.tab).some(
                  (id) => id !== closeAuthority.ptyId
                )))
          ) {
            throw new Error('terminal_pane_owner_changed')
          }
          options.beforeAction?.()
        }
        admitClose()
        const outcome = await this.closeMobileSessionTab(`id:${closeAuthority.worktreeId}`, tabId, {
          reason: 'user',
          localPtyTeardownOwnedExternally: true,
          ...(ptyCloseAuthority
            ? { expectedPtyCloseAuthority: closeAuthority }
            : { expectedTerminalHandle: handle }),
          beforeAction: () => {
            admitClose()
            committed = true
          }
        })
        if (outcome.refused || outcome.retirementConfirmed !== true) {
          throw new Error(outcome.refusalReason ?? 'terminal_close_not_committed')
        }
        // The owner committed; its own removal cannot revoke completion of this exact action.
        committed = true
        const stop = await this.stopExplicitlyClosedTabPtys(
          ptyIdsToKill,
          closeAuthority.ptyId,
          undefined,
          incarnations
        )
        return this.describeTerminalClose(handle, tabId, closeAuthority.ptyId, stop)
      }
      // Headless hosts have no renderer tab to close through the notifier.
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
          beforeAction?.()
          await this.notifier.closeTerminalTab(tabId, { localPtyTeardownOwnedExternally: true })
        } catch (error) {
          // The tab went away concurrently; fall through and close the PTY alone.
          if (!(error instanceof Error) || error.message !== 'tab_not_found') {
            throw error
          }
          tabClosed = false
        }
        if (tabClosed) {
          const stop = await this.stopExplicitlyClosedTabPtys(
            ptyIdsToKill,
            pty.pty.ptyId,
            beforeAction
          )
          return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
        }
      }
      const stop = await this.stopExplicitlyClosedTabPtys(
        [pty.pty.ptyId],
        pty.pty.ptyId,
        beforeAction
      )
      if (!closesTab) {
        // Commit this pane's removal explicitly; unconfirmed stop never authorizes closing live siblings.
        if (paneTarget) {
          await this.closeTerminalPane(pty.pty.worktreeId, paneTarget)
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
      beforeAction?.()
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
      ? await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, leaf.ptyId, beforeAction)
      : NO_STOP
    if (!closesTab) {
      await this.closeTerminalPane(leaf.worktreeId, paneTarget)
    } else if (!this.notifier?.closeTerminalTab) {
      this.notifier?.closeTerminal(leaf.tabId)
    }
    return this.describeTerminalClose(handle, leaf.tabId, leaf.ptyId ?? null, stop)
  }
}
