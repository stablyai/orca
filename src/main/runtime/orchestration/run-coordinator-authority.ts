import { isEquivalentPaneKey } from './db/pane-key-match'
import type { RunRow } from './types'

export type RunCoordinatorIdentity = {
  handle: string
  paneKey: string | null
  processIncarnation: string | null
  hostScope: string | null
}

export function isCurrentRunCoordinator(run: RunRow, identity: RunCoordinatorIdentity): boolean {
  if (run.coordinator_authority_revision < 0) {
    return false
  }
  const hasProcessAuthority = Boolean(
    run.coordinator_process_incarnation || run.coordinator_host_scope
  )
  if (hasProcessAuthority) {
    return Boolean(
      run.coordinator_process_incarnation &&
      identity.processIncarnation &&
      run.coordinator_process_incarnation === identity.processIncarnation &&
      run.coordinator_host_scope === identity.hostScope
    )
  }
  return Boolean(
    run.coordinator_handle === identity.handle &&
    run.coordinator_pane_key &&
    identity.paneKey &&
    isEquivalentPaneKey(run.coordinator_pane_key, identity.paneKey)
  )
}
