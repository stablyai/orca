import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnResult } from '../../../providers/pty-provider-contract'
import {
  isCurrentPtyExit,
  ptyIncarnationById,
  ptyOwnership,
  setAdoptedPtyOwnership,
  setPtyOwnership
} from '../provider/ownership-state'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { finishPtyShutdown, isPtyAlreadyGoneError } from '../provider/liveness'
import { PtyExitProof } from '../../../pty-exit-proof'
import { errorMessage } from '../../../../shared/error-message'
import { retirePersistedStablePaneOwner } from './stable-owner'

/** Tracks a PTY from its spawn reply, before any save: only an observed exit, or a stop on proof,
 *  removes it, so a spawn whose save or stop fails is never forgotten. */
export function admitPtySpawnOwnership(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult
): void {
  if (result.isReattach || result.agentSessionEnsure?.disposition === 'adopted') {
    runtime?.assertPtyRegistrationAllowed?.(result.id, result.incarnationId)
    // A failed local save must not strand a live process already admitted by its host.
    setAdoptedPtyOwnership(result.id)
  } else if (exitedBeforeAdmission(runtime, result)) {
    // Its exit listener already ran; tracking it now would resurrect it.
    return
  } else {
    setPtyOwnership(result.id, LOCAL_EXECUTION_HOST_ID)
  }
  if (result.incarnationId) {
    ptyIncarnationById.set(result.id, result.incarnationId)
  }
}

/** The runtime's incarnation-scoped start fence, read without failing the commit: registration
 *  reports the early exit itself. */
function exitedBeforeAdmission(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult
): boolean {
  try {
    runtime?.assertPtyRegistrationAllowed?.(result.id, result.incarnationId)
    return false
  } catch (error) {
    if (error instanceof Error && error.message === 'agent_session_exited_during_start') {
      return true
    }
    throw error
  }
}

export async function discardUnpersistedPtySpawn(
  provider: IPtyProvider,
  result: PtySpawnResult,
  runtime: Pick<OrcaRuntimeService, 'markPtyLivenessUnverifiable'> | undefined
): Promise<void> {
  if (
    result.isReattach ||
    result.agentSessionEnsure?.disposition === 'adopted' ||
    !isCurrentPtyExit(result)
  ) {
    return
  }
  let proof: PtyExitProof
  try {
    await provider.shutdown(result.id, {
      immediate: true,
      ...(result.incarnationId ? { expectedIncarnationId: result.incarnationId } : {})
    })
    proof = PtyExitProof.from('shutdown-acknowledged', result.incarnationId)
  } catch (error) {
    if (!isPtyAlreadyGoneError(error)) {
      console.warn('[pty] failed to clean up PTY after persistence failure:', error)
      // An observed exit, or a same-id replacement, outranks a lost control reply.
      if (
        !ptyOwnership.has(result.id) ||
        ptyIncarnationById.get(result.id) !== result.incarnationId
      ) {
        return
      }
      // Keep ownership: the process may still run, so it reads unverifiable until it exits or an
      // orphan sweep reaps it, never forgotten.
      runtime?.markPtyLivenessUnverifiable?.(
        result.id,
        `discard shutdown failed: ${errorMessage(error)}`
      )
      return
    }
    proof = PtyExitProof.from('absent', result.incarnationId)
  }
  // The proof names this incarnation, so a replacement that arrived meanwhile keeps its own.
  finishPtyShutdown(result.id, null, undefined, proof)
}

// Successful registration must not yield before the remaining spawn publication.
export function registerPersistedPtySpawn(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  ...args: Parameters<OrcaRuntimeService['registerPty']>
): Promise<never> | undefined {
  try {
    runtime?.registerPty(...args)
  } catch (error) {
    const [ptyId, worktreeId, connectionId, binding] = args
    // An exit during the binding write precedes runtime surface registration.
    if (
      error instanceof Error &&
      error.message === 'agent_session_exited_during_start' &&
      runtime?.getPtyLivenessVerdict?.(ptyId)?.status === 'exited' &&
      binding
    ) {
      return retirePersistedStablePaneOwner(
        store,
        { ...binding, ptyId, persistedIncarnationId: binding.incarnationId },
        worktreeId,
        connectionId
      ).then(() => {
        throw error
      })
    }
    throw error
  }
  return undefined
}
