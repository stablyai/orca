import { createSetupCompletionObservation } from '../../orchestration/setup-completion-signal'
import { OrcaRuntimeWithPtyRegistrationClaims } from './pty-registration-claims'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import type {
  RuntimePtyRegistrationBinding,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { OrchestrationCompatibilityTerminalAuthority } from '../../runtime-terminal-contracts'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-session-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { mainTerminalRegistered } from '../surface/main-terminal-surfaces'
import { assertPaneBoundAtRegistration, isRuntimeHostedWorkspace } from './bind-first-registration'

export abstract class OrcaRuntimeWithRegisterPty extends OrcaRuntimeWithPtyRegistrationClaims {
  protected abstract ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null

  protected abstract getOrchestrationCompatibilityHostScope(
    pty: RuntimePtyWorktreeRecord
  ): OrchestrationCompatibilityTerminalAuthority['hostScope'] | null

  protected abstract watchLaunchComposer(ptyId: string, agent: TuiAgent | null): void

  registerPty(
    ptyId: string,
    worktreeId: string,
    connectionId: string | null = null,
    binding?: RuntimePtyRegistrationBinding,
    isWsl?: boolean
  ): void {
    this.assertPtyDidNotExitBeforeRegistration(ptyId, binding?.incarnationId)
    const existingPty = this.ptysById.get(ptyId)
    // Why: a relay reattach can finish registering after a stop recorded that incarnation's exit.
    if (
      binding?.incarnationId !== undefined &&
      existingPty?.incarnationId === binding.incarnationId &&
      !existingPty.connected &&
      this.getPtyLivenessVerdict(ptyId)?.status === 'exited'
    ) {
      return
    }
    this.invalidatePtyControllerInventoryForLifecycle(ptyId, connectionId)
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
    const claim = this.pendingPtyRegistrationIncarnations.get(ptyId)
    const preserveEarly =
      claim?.setupObservation !== undefined && claim.incarnationId === binding?.incarnationId
    if (incarnationChanged || pendingReplacementMatches) {
      if (!preserveEarly) {
        this.setupCompletionTokenByPtyId.get(ptyId)?.fail(new Error('terminal_handle_stale'))
        this.setupCompletionTokenByPtyId.delete(ptyId)
      }
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
    if (preserveEarly) {
      claim.previousSetupObservation?.fail(new Error('terminal_handle_stale'))
    }
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
    this.mainDaemonAttachments.markSpawnPublished(ptyId)
    // Record spawn-time pane identity so stalled graph sync cannot hide the live PTY backing a pending mobile create.
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
      ...(binding && paneKey
        ? {
            tabId: binding.tabId,
            paneKey,
            surfaceRecordedAtGraphSequence: spawnSurfaceClaimSequence(this.graphSequence)
          }
        : {}),
      ...(binding?.incarnationId ? { incarnationId: binding.incarnationId } : {})
    })
    // Bind-first applies to main-owned layouts; paired-server workspaces and storeless test runtimes have no local binding to assert (L80).
    if (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      paneKey &&
      this.store?.getWorkspaceSession &&
      !isRuntimeHostedWorkspace(this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId))
    ) {
      assertPaneBoundAtRegistration(ptyId, paneKey, this.paneOfPty(pty).paneKey)
    }
    if (binding?.setupCompletionToken) {
      let observed = this.setupCompletionTokenByPtyId.get(ptyId)
      if (!observed) {
        observed = createSetupCompletionObservation(binding.setupCompletionToken)
        this.setupCompletionTokenByPtyId.set(ptyId, observed)
        if (!binding.setupCompletionToken.startsWith('native:')) {
          observed.scan(this.recentPtyOutputById.get(ptyId)?.read() ?? '')
        }
      }
      observed.publish()
      const completion = observed.completion
      this.workspaceSetupAgentStarts.observe(worktreeId, () => completion)
    }
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (paneKey && binding?.incarnationId && hostScope) {
      this._orchestrationDb?.retainReplacedWorkerTerminalResources({
        paneKey,
        worktreeId,
        hostScope: JSON.stringify(hostScope),
        processIncarnation: `${ptyId}:${binding.incarnationId}`
      })
    }
    const agentLaunchAuthority = binding?.agentLaunchAuthority
    if (
      agentLaunchAuthority &&
      paneKey &&
      binding.incarnationId &&
      pty.incarnationId === binding.incarnationId &&
      this.paneOfPty(pty).paneKey === paneKey &&
      pty.launchToken === null &&
      agentLaunchAuthority.launchToken.length > 0 &&
      agentLaunchAuthority.launchToken.length <= 128 &&
      isTuiAgent(agentLaunchAuthority.launchAgent)
    ) {
      pty.launchToken = agentLaunchAuthority.launchToken
      pty.launchIncarnationId = binding.incarnationId
      pty.launchAgent = agentLaunchAuthority.launchAgent
    }
    this.watchLaunchComposer(ptyId, binding?.launchedAgent ?? null)
    const providerReattachLaunchIdentity = binding?.providerReattachLaunchIdentity
    if (
      providerReattachLaunchIdentity &&
      paneKey &&
      binding.incarnationId === providerReattachLaunchIdentity.incarnationId &&
      pty.incarnationId === providerReattachLaunchIdentity.incarnationId &&
      this.paneOfPty(pty).paneKey === paneKey &&
      isTuiAgent(providerReattachLaunchIdentity.launchAgent)
    ) {
      // Why: daemon metadata owns the surviving process; its incarnation fence restores identity without minting renderer launch authority.
      pty.launchAgent = providerReattachLaunchIdentity.launchAgent
    }
    const pendingIncarnation = this.pendingPtyRegistrationIncarnations.get(ptyId)?.incarnationId
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
    // Switch point: a pane main binds lists its terminal now, in the same push as the flip below.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      mainTerminalRegistered(this, ptyId)
    }
    // Why: a listed surface's pending-handle → ready flip must not wait on a later renderer graph change.
    this.touchMobileSessionSnapshotsForPty(ptyId)
    // Renderer spawn proves the pending mobile tab is live; publish without waiting for its graph (#7587).
    if (binding && paneKey) {
      if (
        replacementHandle?.startsWith('term_') &&
        this.handleByPtyId.get(ptyId) !== replacementHandle
      ) {
        this.registerPreAllocatedHandleForPty(ptyId, replacementHandle)
      }
      this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, binding.tabId)
    }
  }
}
