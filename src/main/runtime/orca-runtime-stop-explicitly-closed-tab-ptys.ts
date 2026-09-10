// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithFocusTerminal } from './orca-runtime-focus-terminal'
import { EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS } from './orca-runtime-core'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../shared/pty-liveness-verdict'
import type { RuntimeTerminalClose } from '../../shared/runtime-types'
import { countTerminalLayoutLeaves } from './headless-terminal-split-layout'
import type { RuntimePtyTabCloseAuthority } from './runtime-terminal-state-records'

export class OrcaRuntimeWithStopExplicitlyClosedTabPtys extends OrcaRuntimeWithFocusTerminal {
  protected async stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string
  ): Promise<boolean> {
    let addressedPtyStopped = false
    const deadlineMs = Date.now() + EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS
    for (const ptyId of ptyIds) {
      this.markPtyStopRequested(ptyId)
      let stopped = false
      if (this.ptyController?.stopAndWait) {
        try {
          stopped = await this.ptyController.stopAndWait(ptyId, { deadlineMs })
        } catch (error) {
          this.markPtyLivenessUnverifiable(
            ptyId,
            error instanceof Error ? error.message : String(error)
          )
        }
        if (!stopped) {
          const verdict = this.getPtyLivenessVerdict(ptyId)
          const providerAlreadyRetiredPty =
            verdict?.status === 'unverifiable' &&
            verdict.reason === SSH_PROVIDER_UNREGISTERED_REASON
          if (!providerAlreadyRetiredPty) {
            this.ptyController.kill(ptyId)
            if (!verdict || verdict.status === 'live') {
              this.markPtyLivenessUnverifiable(
                ptyId,
                'a follow-up stop was issued but its outcome could not be verified'
              )
            }
          }
        }
      } else {
        stopped = this.ptyController?.kill(ptyId) ?? false
      }
      if (ptyId === addressedPtyId) {
        addressedPtyStopped = stopped
      }
    }
    return addressedPtyStopped
  }

  protected describeTerminalClose(
    handle: string,
    tabId: string,
    ptyId: string | null,
    ptyKilled: boolean
  ): RuntimeTerminalClose {
    if (ptyKilled || !ptyId) {
      return { handle, tabId, ptyKilled }
    }
    const verdict = this.getPtyLivenessVerdict(ptyId)
    if (verdict?.status === 'unverifiable') {
      return {
        handle,
        tabId,
        ptyKilled,
        ptyStopVerdict: 'unverifiable',
        ptyStopReason: verdict.reason
      }
    }
    if (verdict?.status === 'live') {
      return { handle, tabId, ptyKilled, ptyStopVerdict: 'live' }
    }
    return { handle, tabId, ptyKilled }
  }

  async closeTerminal(handle: string): Promise<RuntimeTerminalClose> {
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
      const spawnSurface = pty.pty.tabId
        ? this.findMobileTerminalSurface(pty.pty.worktreeId, pty.pty.tabId)
        : null
      // Why: PTY exit can immediately replace a ready SSH publication with a pending one, so capture its durable HUB surface before killing it.
      const surface =
        ptyCloseAuthority?.surface ??
        (spawnSurface && this.getMobileTerminalLeafPtyIds(spawnSurface.tab).length === 0
          ? spawnSurface
          : null)
      const tabId = surface?.tab.parentTabId ?? pty.pty.tabId ?? pty.record.tabId
      // Why: relay recovery can leave stale renderer leaves; the persisted HUB layout defines whether closing this PTY closes the whole surface.
      const siblingCount = surface?.tab.parentLayout
        ? countTerminalLayoutLeaves(surface.tab.parentLayout.root)
        : this.countLeavesInTab(tabId)
      if (siblingCount <= 1 && surface && this.tabs.has(tabId) && this.notifier?.closeTerminalTab) {
        const ptyIdsToKill = this.getPtyIdsForExplicitTabClose(pty.pty.worktreeId, tabId)
        try {
          await this.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, {
            localPtyTeardownOwnedExternally: true
          })
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
            throw error
          }
          this.notifier.closeTerminal?.(tabId)
        }
        const ptyKilled = await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, ptyKilled)
      }
      if (
        siblingCount <= 1 &&
        surface &&
        ptyCloseAuthority &&
        !this.tabs.has(surface.tab.parentTabId)
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
          const ptyKilled = await this.stopExplicitlyClosedTabPtys([pty.pty.ptyId], pty.pty.ptyId)
          this.notifier?.closeTerminal(tabId)
          return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, ptyKilled)
        }
        const ptyKilled = await this.stopExplicitlyClosedTabPtys([pty.pty.ptyId], pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, ptyKilled)
      }
      if (siblingCount <= 1 && !surface && pty.pty.tabId && this.notifier?.closeTerminalTab) {
        const ptyIdsToKill = this.getPtyIdsForExplicitTabClose(pty.pty.worktreeId, tabId)
        await this.notifier.closeTerminalTab(tabId, { localPtyTeardownOwnedExternally: true })
        const ptyKilled = await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, ptyKilled)
      }
      const ptyKilled = await this.stopExplicitlyClosedTabPtys([pty.pty.ptyId], pty.pty.ptyId)
      if (!ptyKilled || siblingCount <= 1) {
        if (surface) {
          // Why: paired viewers keep ended streams mounted until the HUB publishes removal, so explicit close uses the durable host-tab transaction instead of viewer-local exit handling.
          try {
            await this.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, {
              localPtyTeardownOwnedExternally: true
            })
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
              throw error
            }
            this.notifier?.closeTerminal(tabId)
          }
        } else {
          this.notifier?.closeTerminal(tabId)
        }
      }
      return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, ptyKilled)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    // Why: in a multi-pane tab, killing the PTY is enough (renderer's exit handler closes the pane); an extra IPC close would race it and close the whole tab.
    const siblingCount = this.countLeavesInTab(leaf.tabId)
    const ptyIdsToKill =
      siblingCount <= 1
        ? this.getPtyIdsForExplicitTabClose(leaf.worktreeId, leaf.tabId)
        : leaf.ptyId
          ? [leaf.ptyId]
          : []
    if (siblingCount <= 1 && this.notifier?.closeTerminalTab) {
      await this.notifier.closeTerminalTab(leaf.tabId, { localPtyTeardownOwnedExternally: true })
    }
    const ptyKilled = leaf.ptyId
      ? await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, leaf.ptyId)
      : false
    if (siblingCount > 1 ? !ptyKilled : !this.notifier?.closeTerminalTab) {
      this.notifier?.closeTerminal(leaf.tabId, leaf.paneRuntimeId)
    }
    return this.describeTerminalClose(handle, leaf.tabId, leaf.ptyId ?? null, ptyKilled)
  }

  async closeTerminalTab(handle: string): Promise<RuntimeTerminalClose> {
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
        pty.pty.tabId
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
    await this.closeMobileSessionTab(`id:${leaf.worktreeId}`, leaf.tabId, { reason: 'user' })
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
    return { handle, tabId: leaf.tabId, closeMode: 'tab', ptyKilled: false }
  }
}
