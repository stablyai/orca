import type { WorktreePtyHostFence } from '../worktree-pty-host-fence'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from '../runtime-terminal-state-records'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { closeMainOwnedPaneByHandle } from './main-handle-close'
import { OrcaRuntimeWithExplicitTerminalPaneClose } from './explicit-terminal-pane-close'

export abstract class OrcaRuntimeWithStopExplicitlyClosedTabPtys extends OrcaRuntimeWithExplicitTerminalPaneClose {
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
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

  async closeTerminalTab(handle: string): Promise<RuntimeTerminalClose> {
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
