import { principalFromPaneKey } from '../../../../../shared/orchestration-principal'
import type { RunCoordinatorBinding } from '../../types'

/** Either the resolver's opaque binding or the legacy handle+pane shape existing callers pass. */
export type RunCoordinatorParam =
  | { coordinator: RunCoordinatorBinding }
  | { coordinatorHandle: string; coordinatorPaneKey: string }

/** Legacy shape normalizes through the same classification as PR 1's dual-write derivation. */
export function runCoordinatorBinding(params: RunCoordinatorParam): RunCoordinatorBinding {
  if ('coordinator' in params) {
    return params.coordinator
  }
  const principalId = principalFromPaneKey(params.coordinatorPaneKey)
  if (!principalId) {
    throw new Error('A run coordinator binding requires a non-empty pane key.')
  }
  return {
    principalId,
    terminalHandle: params.coordinatorHandle,
    paneKey: params.coordinatorPaneKey
  }
}
