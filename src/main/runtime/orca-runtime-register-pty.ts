// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithInvalidateAllHandlesForPty } from './orca-runtime-invalidate-all-handles-for-pty'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TuiAgent } from '../../shared/tui-agent'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { isTuiAgent } from '../../shared/tui-agent-config'

export class OrcaRuntimeWithRegisterPty extends OrcaRuntimeWithInvalidateAllHandlesForPty {
  registerPty(
    ptyId: string,
    worktreeId: string,
    connectionId: string | null = null,
    binding?: {
      tabId: string
      leafId: string
      incarnationId?: PtyIncarnationId
      /** Handle allocated for the replacement incarnation, when one is known. */
      terminalHandle?: string
      agentLaunchAuthority?: { launchToken: string; launchAgent: TuiAgent }
      providerReattachLaunchIdentity?: {
        incarnationId: PtyIncarnationId
        launchAgent: TuiAgent
      }
    },
    isWsl?: boolean
  ): void {
    this.assertPtyDidNotExitBeforeRegistration(ptyId, binding?.incarnationId)
    const existingPty = this.ptysById.get(ptyId)
    const replacementHandle = binding?.terminalHandle?.trim()
    const pendingReplacement = this.pendingPtyHandleReplacementFences.get(ptyId)
    const pendingReplacementMatches =
      pendingReplacement !== undefined &&
      pendingReplacement.pendingRegistration &&
      binding?.incarnationId !== undefined &&
      pendingReplacement.incarnationId === binding.incarnationId
    const incarnationChanged =
      existingPty !== undefined &&
      binding?.incarnationId !== undefined &&
      existingPty.incarnationId !== null &&
      existingPty.incarnationId !== binding.incarnationId
    if (incarnationChanged || pendingReplacementMatches) {
      // A reconnect can register a replacement before inventory reports its exported handle.
      // Drop every alias for the predecessor; a newly preallocated handle is retained only when
      // the caller can prove it is the replacement's handle.
      const directHandle = this.handleByPtyId.get(ptyId)
      const canPreserveReplacementHandle =
        replacementHandle !== undefined &&
        replacementHandle.startsWith('term_') &&
        directHandle === replacementHandle &&
        !pendingReplacement?.staleHandles.has(replacementHandle)
      const invalidated = this.invalidateAllHandlesForPty(
        ptyId,
        canPreserveReplacementHandle ? replacementHandle : undefined
      )
      if (binding?.incarnationId) {
        this.rememberPtyHandleReplacementFence(
          ptyId,
          binding.incarnationId,
          invalidated,
          pendingReplacementMatches
        )
      }
    }
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
    this.terminalViewSubscribers.markSpawnPublished(ptyId)
    // Why: record the renderer pane identity at spawn time so a stalled graph
    // sync can't hide that a live PTY already backs a pending mobile create.
    const paneKey =
      binding && isValidTerminalTabId(binding.tabId) && isTerminalLeafId(binding.leafId)
        ? makePaneKey(binding.tabId, binding.leafId)
        : null
    const pty = this.recordPtyWorktree(ptyId, worktreeId, {
      connected: true,
      connectionId,
      ...(binding && this.pendingMobileTerminalCreatesByKey.has(`${worktreeId}::${binding.tabId}`)
        ? { runtimeSessionOwned: true }
        : {}),
      ...(isWsl !== undefined ? { isWsl } : {}),
      ...(binding && paneKey ? { tabId: binding.tabId, paneKey } : {}),
      ...(binding?.incarnationId ? { incarnationId: binding.incarnationId } : {})
    })
    const agentLaunchAuthority = binding?.agentLaunchAuthority
    if (
      agentLaunchAuthority &&
      paneKey &&
      binding.incarnationId &&
      pty.incarnationId === binding.incarnationId &&
      pty.paneKey === paneKey &&
      pty.launchToken === null &&
      agentLaunchAuthority.launchToken.length > 0 &&
      agentLaunchAuthority.launchToken.length <= 128 &&
      isTuiAgent(agentLaunchAuthority.launchAgent)
    ) {
      pty.launchToken = agentLaunchAuthority.launchToken
      pty.launchIncarnationId = binding.incarnationId
      pty.launchAgent = agentLaunchAuthority.launchAgent
    }
    const providerReattachLaunchIdentity = binding?.providerReattachLaunchIdentity
    if (
      providerReattachLaunchIdentity &&
      paneKey &&
      binding.incarnationId === providerReattachLaunchIdentity.incarnationId &&
      pty.incarnationId === providerReattachLaunchIdentity.incarnationId &&
      pty.paneKey === paneKey &&
      isTuiAgent(providerReattachLaunchIdentity.launchAgent)
    ) {
      // Why: daemon metadata owns the surviving process; its incarnation fence restores identity without minting renderer launch authority.
      pty.launchAgent = providerReattachLaunchIdentity.launchAgent
    }
    const pendingIncarnation = this.pendingPtyRegistrationIncarnations.get(ptyId)
    if (
      pendingIncarnation === null ||
      pendingIncarnation === undefined ||
      binding?.incarnationId === undefined ||
      pendingIncarnation === binding.incarnationId
    ) {
      this.pendingPtyRegistrationIncarnations.delete(ptyId)
    }
    if (pendingReplacement !== undefined) {
      const currentFence = this.pendingPtyHandleReplacementFences.get(ptyId)
      if (currentFence && (pendingReplacementMatches || !binding?.incarnationId)) {
        currentFence.pendingRegistration = false
      }
    }
    // Why: the renderer's own PTY spawn is the reliable signal that the pending
    // mobile create's tab is live; publish its surface main-side (#7587).
    if (binding && paneKey) {
      this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, binding.tabId)
    }
  }

  assertPtyRegistrationAllowed(ptyId: string, incarnationId?: PtyIncarnationId): void {
    // Why: the controller must reject an early exit before persisting bindings or handles.
    this.assertPtyDidNotExitBeforeRegistration(ptyId, incarnationId)
  }

  releaseRejectedPtyRegistrationFence(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    if (!this.earlyExitedPtyIncarnations.has(ptyId)) {
      return
    }
    const exitedIncarnation = this.earlyExitedPtyIncarnations.get(ptyId) ?? null
    if (
      exitedIncarnation === null ||
      candidateIncarnation === undefined ||
      exitedIncarnation === candidateIncarnation
    ) {
      // Why: the rejected spawn call was the fence's sole late publisher; retaining it leaks fresh PTY ids.
      this.earlyExitedPtyIncarnations.delete(ptyId)
      this.pendingPtyRegistrationIncarnations.delete(ptyId)
    }
  }

  beginPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId): void {
    this.pendingPtyRegistrationIncarnations.set(ptyId, incarnationId ?? null)
  }

  acceptPtyIncarnationForExit(ptyId: string, incarnationId: PtyIncarnationId): void {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      // Why: a reconnect attach reply can prove the exit generation after stale local proof was cleared.
      pty.incarnationId = incarnationId
    }
  }

  cancelPendingPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId): void {
    const pending = this.pendingPtyRegistrationIncarnations.get(ptyId)
    if (
      !this.pendingPtyRegistrationIncarnations.has(ptyId) ||
      (pending !== null && incarnationId !== undefined && pending !== incarnationId)
    ) {
      return
    }
    this.pendingPtyRegistrationIncarnations.delete(ptyId)
    const exited = this.earlyExitedPtyIncarnations.get(ptyId)
    if (
      exited === null ||
      exited === undefined ||
      incarnationId === undefined ||
      exited === incarnationId
    ) {
      this.earlyExitedPtyIncarnations.delete(ptyId)
    }
  }

  protected assertPtyDidNotExitBeforeRegistration(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    if (this.earlyExitedPtyIncarnations.has(ptyId)) {
      const exitedIncarnation = this.earlyExitedPtyIncarnations.get(ptyId) ?? null
      const nextIncarnation = candidateIncarnation ?? null
      if (
        exitedIncarnation === null ||
        nextIncarnation === null ||
        exitedIncarnation === nextIncarnation
      ) {
        throw new Error('agent_session_exited_during_start')
      }
      this.earlyExitedPtyIncarnations.delete(ptyId)
    }
  }
}
