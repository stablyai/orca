import type { Store } from '../../persistence'
import type { PersistPtyBindingArgs } from '../../persistence/loading-store/pty-binding-persistence'
import { ptyBindingIsRefused } from '../../persistence/loading-store/pty-binding-refusals'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { createTerminalSessionStateSaveFailureMessage } from '../../../shared/terminal-session-state-save-failure'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnResult } from '../../providers/pty-provider-contract'
import {
  isAbsentBindingReplay,
  PaneOwnerContentionError,
  type AbsentPaneBinding
} from './pane/pane-spawn-operation'
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

/** Runs inside the existing durable mutation, after source/topology checks and before any bind. */
export async function persistFreshPaneBinding(
  store: Store,
  binding: PersistPtyBindingArgs,
  connectionId?: string | null,
  absentOwner?: AbsentPaneBinding
): Promise<boolean> {
  let targetChanged = false
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  const persisted = await store.persistPtyBinding(() => {
    const session = store.getWorkspaceSession(hostId)
    const paneKey = makePaneKey(binding.tabId, binding.leafId)
    if (ptyBindingIsRefused(binding, session, binding.worktreeId, paneKey, [])) {
      return binding
    }
    const bound = session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
    const stamp = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
    if (
      bound &&
      (bound !== binding.ptyId || stamp !== binding.incarnationId) &&
      !isAbsentBindingReplay(absentOwner, bound, stamp)
    ) {
      targetChanged = true
      return null
    }
    return binding
  }, hostId)
  if (targetChanged) {
    throw new PaneOwnerContentionError()
  }
  return persisted
}
