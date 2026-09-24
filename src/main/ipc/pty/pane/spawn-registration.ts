import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { retirePersistedStablePaneOwner } from './stable-owner'

export async function registerPersistedPtySpawn(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  ...args: Parameters<OrcaRuntimeService['registerPty']>
): Promise<void> {
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
      await retirePersistedStablePaneOwner(
        store,
        { ...binding, ptyId, persistedIncarnationId: binding.incarnationId },
        worktreeId,
        connectionId
      )
    }
    throw error
  }
}
