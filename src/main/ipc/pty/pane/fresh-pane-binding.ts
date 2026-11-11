import type { Store } from '../../../persistence/loading-store/store'
import type { PersistPtyBindingArgs } from '../../../persistence/loading-store/pty-binding-persistence'
import { ptyBindingIsRefused } from '../../../persistence/loading-store/pty-binding-refusals'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import {
  isAbsentBindingReplay,
  PaneOwnerContentionError,
  type AbsentPaneBinding
} from './pane-spawn-operation'

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
