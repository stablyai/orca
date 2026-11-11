import type { Store } from '../../persistence/loading-store/store'
import type { PersistPtyBindingArgs } from '../../persistence/loading-store/terminal-bindings/pty-binding-persistence'
import { createTerminalSessionStateSaveFailureMessage } from '../../../shared/workspace-session/terminal-session-state-save-failure'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnResult } from '../../providers/pty-provider-contract'
import { PaneOwnerContentionError, type AbsentPaneBinding } from './pane/pane-spawn-operation'
import { persistFreshPaneBinding } from './pane/fresh-pane-binding'
import { swapReplacedPaneBinding } from './pane/pane-owner-replacement'
import type { ReplacedPaneOwner } from './pane/replaced-pane-owner'
import { discardUnpersistedPtySpawn } from './pane/spawn-registration'

/** A lane's pane binding for its new process, saved before the spawn is acknowledged. */
export type PtySpawnPaneBinding = {
  store: Store
  binding: PersistPtyBindingArgs
  absentOwner?: AbsentPaneBinding
  /** What a refused bind throws; each lane's callers match on their own message. */
  refusal: 'terminal_pane_owner_changed' | 'terminal_split_source_not_found'
  failureLog: string
}

/** Saves the binding, or a swap over the replaced owner; a failed save discards the new process. */
export async function savePtySpawnPaneBinding(
  state: {
    result: PtySpawnResult
    stablePaneBindingPersisted?: boolean
    provider: IPtyProvider
    replacedPaneOwner?: ReplacedPaneOwner | null
    deps: { runtime?: OrcaRuntimeService }
  },
  { store, binding, absentOwner, refusal, failureLog }: PtySpawnPaneBinding,
  connectionId: string | null | undefined
): Promise<void> {
  const replaced = state.replacedPaneOwner
  try {
    const persisted = replaced
      ? await store.persistPtyBinding(swapReplacedPaneBinding(store, binding, replaced))
      : await persistFreshPaneBinding(store, binding, connectionId, absentOwner)
    if (persisted === false) {
      throw new Error(refusal)
    }
    state.stablePaneBindingPersisted = true
    if (replaced) {
      // The swap holds the live binding now: a later failure must not retire it under the same id.
      state.replacedPaneOwner = null
    }
  } catch (err) {
    console.error(failureLog, err)
    await discardUnpersistedPtySpawn(state.provider, state.result, state.deps.runtime)
    if (
      err instanceof PaneOwnerContentionError ||
      (err instanceof Error && err.message === refusal)
    ) {
      throw err
    }
    throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage(err)), {
      agentSessionOperationOutcome: 'unknown' as const
    })
  }
}
