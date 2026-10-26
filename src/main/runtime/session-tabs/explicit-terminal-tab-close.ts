import { OrcaRuntimeWithExplicitCloseTabPtyStops } from './explicit-terminal-close-pty-stops'
export { NO_STOP } from './explicit-terminal-close-pty-stops'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import type { RuntimePtyTabCloseAuthority } from '../runtime-terminal-state-records'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { closeMainOwnedPaneByHandle } from './main-handle-close'
import {
  closePairedHostLeafFirst,
  isTerminalTabPinnedInSession
} from './paired-host-terminal-close'

export abstract class OrcaRuntimeWithExplicitTerminalTabClose extends OrcaRuntimeWithExplicitCloseTabPtyStops {
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>
  /** null when this machine owns the PTY; see `closePairedHostLeafFirst` otherwise. */
  protected closeOnOwningPairedHost(
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

  async closeTerminalTab(handle: string): Promise<RuntimeTerminalClose> {
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
      // Why: a handle-addressed CLI/automation close is an explicit intent, so
      // it must stay destructive under the non-user close adjudication gate.
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
