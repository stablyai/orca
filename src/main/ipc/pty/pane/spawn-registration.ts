import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnResult } from '../../../providers/types'
import { isCurrentPtyExit, ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { retirePersistedStablePaneOwner } from './stable-owner'

export function admitPtyReattachOwnership(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult,
  connectionId: string | null | undefined
): void {
  if (!result.isReattach && result.agentSessionEnsure?.disposition !== 'adopted') {
    return
  }
  runtime?.assertPtyRegistrationAllowed?.(result.id, result.incarnationId)
  // A failed local save must not strand a live process already admitted by its host.
  ptyOwnership.set(result.id, connectionId ?? ptyOwnership.get(result.id) ?? null)
  if (result.incarnationId) {
    ptyIncarnationById.set(result.id, result.incarnationId)
  }
}

export async function discardUnpersistedPtySpawn(
  provider: IPtyProvider,
  result: PtySpawnResult,
  onDiscarded?: () => void
): Promise<void> {
  if (
    result.isReattach ||
    result.agentSessionEnsure?.disposition === 'adopted' ||
    !isCurrentPtyExit(result)
  ) {
    return
  }
  try {
    await provider.shutdown(result.id, {
      immediate: true,
      ...(result.incarnationId ? { expectedIncarnationId: result.incarnationId } : {})
    })
  } catch (error) {
    console.warn('[pty] failed to clean up PTY after persistence failure:', error)
  }
  // A replacement may arrive while the execution host finishes shutting down the predecessor.
  if (isCurrentPtyExit(result)) {
    clearProviderPtyState(result.id)
    ptyOwnership.delete(result.id)
    onDiscarded?.()
  }
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
