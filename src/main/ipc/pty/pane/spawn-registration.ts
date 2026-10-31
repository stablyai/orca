import { classifyTerminalCreationFailure } from '../../../../shared/terminal-start-failure'
import type { PtyRegistrationClaim } from '../../../runtime/runtime-terminal-state-records'
import { PaneOwnerContentionError } from './pane-spawn-operation'
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

/** Track before saving; failed save/stop must not make a potentially live process disappear from ownership. */
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

/** Read incarnation-scoped early-exit proof without throwing; registration reports refusal itself. */
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
  runtime:
    | (Pick<OrcaRuntimeService, 'markPtyLivenessUnverifiable'> &
        Partial<Pick<OrcaRuntimeService, 'intentionalPtyStops'>>)
    | undefined
): Promise<void> {
  if (
    result.isReattach ||
    result.agentSessionEnsure?.disposition === 'adopted' ||
    !isCurrentPtyExit(result)
  ) {
    return
  }
  // Discard cleanup is intentional stop, not agent completion; preserve the pane tab.
  const settleStop = runtime?.intentionalPtyStops?.mark(
    result.id,
    'replaced',
    result.incarnationId ?? null
  )
  let stopped = false
  try {
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
        // Keep potentially live ownership as unverifiable until observed exit or successful cleanup.
        runtime?.markPtyLivenessUnverifiable?.(
          result.id,
          `discard shutdown failed: ${errorMessage(error)}`
        )
        return
      }
      proof = PtyExitProof.from('absent', result.incarnationId)
    }
    stopped = true
    // The proof names this incarnation, so a replacement that arrived meanwhile keeps its own.
    finishPtyShutdown(result.id, null, undefined, proof)
  } finally {
    settleStop?.(stopped)
  }
}

// Successful registration must remain synchronous through spawn publication.
export function registerPersistedPtySpawn(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  claim: PtyRegistrationClaim | undefined,
  result: PtySpawnResult | undefined,
  ...args: Parameters<OrcaRuntimeService['registerPty']>
): Promise<never> | undefined {
  try {
    if (claim && !runtime?.narrowPtyRegistration(args[0], claim, args[3]?.incarnationId)) {
      throw new PaneOwnerContentionError()
    }
    runtime?.registerPty(...args)
  } catch (error) {
    const failure = classifyTerminalCreationFailure(error, result)
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
        throw failure
      })
    }
    throw failure
  }
  return undefined
}
