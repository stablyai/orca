import {
  classifyTerminalCreationFailure,
  terminalExitError
} from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import type { PtySpawnResult } from '../../../providers/pty-spawn-result'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { recordFreshLaunch, retireLaunch } from '../launch/launch-evidence'
import type { DaemonLaunchNote } from '../../../daemon/protocol/daemon-launch-note-protocol'
import { OrcaRuntimeWithDaemonLaunchNote } from './daemon-launch-note'
import { isValidTerminalTabId } from '../../../../shared/workspace-layout/terminal-surfaces/terminal-tab-id'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { spawnSurfaceClaimSequence } from '../surface/pty-recorded-surface-topology'
import type {
  PtyRegistrationClaim,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import type { OrchestrationCompatibilityTerminalAuthority } from '../../orchestration/terminal-authority/orchestration-compatibility-authority'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-session-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { mainTerminalRegistered } from '../surface/main-terminal-surfaces'
import { assertPaneBoundAtRegistration, isRuntimeHostedWorkspace } from './bind-first-registration'

export abstract class OrcaRuntimeWithRegisterPty extends OrcaRuntimeWithDaemonLaunchNote {
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
    binding?: {
      tabId: string
      leafId: string
      incarnationId?: PtyIncarnationId
      /** Handle allocated for the replacement incarnation, when one is known. */
      terminalHandle?: string
      agentLaunchAuthority?: {
        launchToken: string
        launchAgent: TuiAgent
        launchConfig?: SleepingAgentLaunchConfig
      }
      /** The agent a fresh spawn's launch command starts, whose submits wait for its composer. */
      launchedAgent?: TuiAgent
      providerReattachLaunchIdentity?: {
        incarnationId: PtyIncarnationId
        launchAgent: TuiAgent
      }
      /** A newly started process, which runs no launch but an admitted one. */
      freshSpawn?: true
      /** A reattach, with its host's launch note; none when the host keeps no notes (an older daemon, SSH). */
      reattach?: { launchNote?: DaemonLaunchNote | null }
    },
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
    if (incarnationChanged || pendingReplacementMatches) {
      // Replacement reconnects can precede handle inventory; drop predecessor aliases unless the caller proves a preallocated handle belongs to the replacement.
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
      recordFreshLaunch(pty, {
        agent: agentLaunchAuthority.launchAgent,
        token: agentLaunchAuthority.launchToken,
        config: agentLaunchAuthority.launchConfig
      })
      this.armDaemonLaunchNote(pty)
    } else if (binding?.freshSpawn && pty.incarnationId === (binding.incarnationId ?? null)) {
      retireLaunch(pty)
    }
    this.watchLaunchComposer(ptyId, binding?.launchedAgent ?? null)
    const providerReattachLaunchIdentity = binding?.providerReattachLaunchIdentity
    let reattachedAgent: TuiAgent | undefined
    if (
      providerReattachLaunchIdentity &&
      paneKey &&
      binding.incarnationId === providerReattachLaunchIdentity.incarnationId &&
      pty.incarnationId === providerReattachLaunchIdentity.incarnationId &&
      this.paneOfPty(pty).paneKey === paneKey &&
      isTuiAgent(providerReattachLaunchIdentity.launchAgent)
    ) {
      // Why: daemon metadata owns the surviving process; its incarnation fence restores identity without minting renderer launch authority.
      pty.launchAgent = reattachedAgent = providerReattachLaunchIdentity.launchAgent
    }
    // An older relay reports no incarnation; that still can't prove the launch gone.
    if (binding?.reattach && (pty.incarnationId ?? undefined) === binding.incarnationId) {
      const { launchNote } = binding.reattach
      this.recordReattachedLaunch(pty, binding.incarnationId, launchNote, reattachedAgent)
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

  assertPtyRegistrationAllowed(ptyId: string, incarnationId?: PtyIncarnationId): void {
    // Why: the controller must reject an early exit before persisting bindings or handles.
    this.assertPtyDidNotExitBeforeRegistration(ptyId, incarnationId)
  }

  protected assertCreatedPtyRegistrationAllowed(result: PtySpawnResult): void {
    const { id: ptyId, incarnationId } = result
    try {
      this.assertPtyDidNotExitBeforeRegistration(ptyId, incarnationId)
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_session_exited_during_start') {
        this.releaseRejectedPtyRegistrationFence(ptyId, incarnationId)
      }
      throw classifyTerminalCreationFailure(error, result)
    }
  }

  releaseRejectedPtyRegistrationFence(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    const pending = this.pendingPtyRegistrationIncarnations.get(ptyId)
    if (pending?.exitedIncarnations.size) {
      this.cancelPendingPtyRegistration(ptyId, candidateIncarnation, pending)
    }
  }

  beginPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId) {
    const claim: PtyRegistrationClaim = {
      incarnationId: incarnationId ?? null,
      exitedIncarnations: new Set()
    }
    this.pendingPtyRegistrationIncarnations.set(ptyId, claim)
    return claim
  }

  narrowPtyRegistration(
    ptyId: string,
    claim: PtyRegistrationClaim,
    incarnationId?: PtyIncarnationId
  ): boolean {
    if (this.pendingPtyRegistrationIncarnations.get(ptyId) !== claim) {
      return false
    }
    claim.incarnationId = incarnationId ?? null
    return true
  }

  acceptPtyIncarnationForExit(ptyId: string, incarnationId: PtyIncarnationId): void {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      // Why: a reconnect attach reply can prove the exit generation after stale local proof was cleared.
      this.terminalIdentity.setPtyIncarnationId(pty, incarnationId)
    }
  }

  cancelPendingPtyRegistration(
    ptyId: string,
    incarnationId?: PtyIncarnationId,
    claim?: PtyRegistrationClaim
  ): void {
    const pending = this.pendingPtyRegistrationIncarnations.get(ptyId)
    if (
      !pending ||
      (claim !== undefined && pending !== claim) ||
      (pending.incarnationId !== null &&
        incarnationId !== undefined &&
        pending.incarnationId !== incarnationId)
    ) {
      return
    }
    this.pendingPtyRegistrationIncarnations.delete(ptyId)
  }

  protected assertPtyDidNotExitBeforeRegistration(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    const exits = this.pendingPtyRegistrationIncarnations.get(ptyId)?.exitedIncarnations
    if (
      exits?.size &&
      (candidateIncarnation === undefined || exits.has(null) || exits.has(candidateIncarnation))
    ) {
      const verdict = this.ptyLivenessVerdictByPtyId.get(ptyId)?.verdict
      const cause =
        candidateIncarnation !== undefined &&
        verdict?.status === 'exited' &&
        verdict.incarnationId === candidateIncarnation
          ? verdict.cause
          : undefined
      throw terminalExitError('agent_session_exited_during_start', cause, candidateIncarnation)
    }
  }
}
