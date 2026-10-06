// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithFocusTerminal } from './orca-runtime-focus-terminal'
import { EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS } from './orca-runtime-core'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../shared/pty-liveness-verdict'
import type { RuntimeTerminalClose } from '../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from './runtime-terminal-state-records'
import { parsePaneKey } from '../../shared/stable-pane-id'

/** How an explicit close's stop of its addressed PTY ended. */
type ExplicitCloseStop = { stopped: boolean; pendingKillRecorded: boolean }

const NO_STOP: ExplicitCloseStop = { stopped: false, pendingKillRecorded: false }

export class OrcaRuntimeWithStopExplicitlyClosedTabPtys extends OrcaRuntimeWithFocusTerminal {
  protected async stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string
  ): Promise<ExplicitCloseStop> {
    let addressedPtyStop = NO_STOP
    const deadlineMs = Date.now() + EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS
    for (const ptyId of ptyIds) {
      this.markPtyStopRequested(ptyId)
      const expectedIncarnationId = this.ptysById.get(ptyId)?.incarnationId
      let stopped = false
      let pendingKillRecorded = false
      if (this.ptyController?.stopAndWait) {
        try {
          stopped = await this.ptyController.stopAndWait(ptyId, { deadlineMs })
        } catch (error) {
          this.markPtyLivenessUnverifiable(
            ptyId,
            error instanceof Error ? error.message : String(error)
          )
        }
        // Preserve an observed exit when a broader inventory check could not finish.
        if (
          !stopped &&
          expectedIncarnationId &&
          this.ptysById.get(ptyId)?.incarnationId === expectedIncarnationId &&
          this.getPtyLivenessVerdict(ptyId)?.status === 'exited'
        ) {
          stopped = true
        }
        if (!stopped) {
          const verdict = this.getPtyLivenessVerdict(ptyId)
          const providerAlreadyRetiredPty =
            verdict?.status === 'unverifiable' &&
            verdict.reason === SSH_PROVIDER_UNREGISTERED_REASON
          if (!providerAlreadyRetiredPty) {
            // Why before the kill: its own failure is recorded only once its RPC settles.
            pendingKillRecorded = this.ptyController.recordUnconfirmedStop?.(ptyId) === true
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
        addressedPtyStop = { stopped, pendingKillRecorded }
      }
    }
    return addressedPtyStop
  }

  protected describeTerminalClose(
    handle: string,
    tabId: string,
    ptyId: string | null,
    stop: ExplicitCloseStop
  ): RuntimeTerminalClose {
    const close: RuntimeTerminalClose = {
      handle,
      tabId,
      ptyKilled: stop.stopped,
      ...(stop.pendingKillRecorded ? { pendingKillRecorded: true as const } : {})
    }
    if (stop.stopped || !ptyId) {
      return close
    }
    const verdict = this.getPtyLivenessVerdict(ptyId)
    if (verdict?.status === 'unverifiable') {
      return { ...close, ptyStopVerdict: 'unverifiable', ptyStopReason: verdict.reason }
    }
    if (verdict?.status === 'live') {
      return { ...close, ptyStopVerdict: 'live' }
    }
    return close
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
      const leafId = surface?.tab.leafId ?? parsePaneKey(pty.pty.paneKey ?? '')?.leafId
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
          this.notifier.closeTerminal?.(tabId)
        }
        const stop = await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, pty.pty.ptyId)
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
          const stop = await this.stopExplicitlyClosedTabPtys([pty.pty.ptyId], pty.pty.ptyId)
          this.notifier?.closeTerminal(tabId)
          return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
        }
        const stop = await this.stopExplicitlyClosedTabPtys([pty.pty.ptyId], pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
      }
      if (closesTab && !surface && pty.pty.tabId && this.notifier?.closeTerminalTab) {
        const ptyIdsToKill = this.getPtyIdsForExplicitTabClose(pty.pty.worktreeId, tabId)
        await this.notifier.closeTerminalTab(tabId, { localPtyTeardownOwnedExternally: true })
        const stop = await this.stopExplicitlyClosedTabPtys(ptyIdsToKill, pty.pty.ptyId)
        return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
      }
      const stop = await this.stopExplicitlyClosedTabPtys([pty.pty.ptyId], pty.pty.ptyId)
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
          this.notifier?.closeTerminal(tabId)
        }
      } else {
        this.notifier?.closeTerminal(tabId)
      }
      return this.describeTerminalClose(handle, tabId, pty.pty.ptyId, stop)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const paneTarget = { kind: 'pane' as const, tabId: leaf.tabId, leafId: leaf.leafId }
    const closesTab = this.resolveTerminalCloseTarget(leaf.worktreeId, paneTarget) === 'last-pane'
    const ptyIdsToKill = closesTab
      ? this.getPtyIdsForExplicitTabClose(leaf.worktreeId, leaf.tabId)
      : leaf.ptyId
        ? [leaf.ptyId]
        : []
    if (closesTab && this.notifier?.closeTerminalTab) {
      await this.notifier.closeTerminalTab(leaf.tabId, { localPtyTeardownOwnedExternally: true })
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
