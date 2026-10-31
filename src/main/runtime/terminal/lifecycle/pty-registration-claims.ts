import { createSetupCompletionObservation } from '../../orchestration/setup-completion-signal'
import {
  classifyTerminalCreationFailure,
  terminalExitError
} from '../../../../shared/terminal-start-failure'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { PtyRegistrationClaim } from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithInvalidateAllHandlesForPty } from './pty-handle-invalidation'

export abstract class OrcaRuntimeWithPtyRegistrationClaims extends OrcaRuntimeWithInvalidateAllHandlesForPty {
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

  beginPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId, setupToken?: string) {
    const pending = this.pendingPtyRegistrationIncarnations.get(ptyId)
    if (
      setupToken === undefined &&
      incarnationId !== undefined &&
      pending?.incarnationId === incarnationId &&
      pending.setupObservation !== undefined &&
      this.setupCompletionTokenByPtyId.get(ptyId) === pending.setupObservation
    ) {
      return pending
    }
    this.cancelPendingPtyRegistration(ptyId)
    const claim: PtyRegistrationClaim = {
      incarnationId: incarnationId ?? null,
      exitedIncarnations: new Set()
    }
    this.pendingPtyRegistrationIncarnations.set(ptyId, claim)
    if (setupToken?.startsWith('native:')) {
      const previous = this.setupCompletionTokenByPtyId.get(ptyId)
      if (previous) {
        claim.previousSetupObservation = previous
      }
      claim.setupObservation = createSetupCompletionObservation(setupToken, true)
      this.setupCompletionTokenByPtyId.set(ptyId, claim.setupObservation)
    }
    return claim
  }

  narrowPtyRegistration(
    ptyId: string,
    claim: PtyRegistrationClaim,
    incarnationId?: PtyIncarnationId,
    adopted = false
  ): boolean {
    if (this.pendingPtyRegistrationIncarnations.get(ptyId) !== claim) {
      return false
    }
    if (adopted && claim.setupObservation) {
      claim.setupObservation.noteGap()
      if (claim.previousSetupObservation) {
        this.setupCompletionTokenByPtyId.set(ptyId, claim.previousSetupObservation)
      } else {
        this.setupCompletionTokenByPtyId.delete(ptyId)
      }
      delete claim.setupObservation
    }
    claim.incarnationId = incarnationId ?? null
    return true
  }

  acceptPtyIncarnationForExit(ptyId: string, incarnationId: PtyIncarnationId): void {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      // Why: a reconnect attach reply can prove the exit generation after stale local proof was cleared.
      pty.incarnationId = incarnationId
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
    if (
      pending.setupObservation &&
      this.setupCompletionTokenByPtyId.get(ptyId) === pending.setupObservation
    ) {
      pending.setupObservation.noteGap()
      if (pending.previousSetupObservation) {
        this.setupCompletionTokenByPtyId.set(ptyId, pending.previousSetupObservation)
      } else {
        this.setupCompletionTokenByPtyId.delete(ptyId)
      }
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
