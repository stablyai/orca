// Catalog/reference authoring acknowledges only after the settings write is durable.
// A debounced save would ack an agent (or a deletion) that a crash, power loss, or disk
// failure can still lose, so the commit runs through the Store's durability barrier and a
// failed write becomes a typed result instead of a swallowed log line.

import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/types'

export type AgentCatalogWriteFailedError = {
  ok: false
  code: 'agent_catalog_write_failed'
  revision: number
}

export type AgentReferenceWriteFailedError = {
  ok: false
  code: 'agent_reference_write_failed'
  referenceRevision: number
  catalogRevision: number
}

/** Commits an authoring patch durably. `false` means the patch was rolled back and
 *  nothing was persisted; the caller must report a failure, never success. */
export function commitAuthoringPatchDurable(store: Store, patch: Partial<GlobalSettings>): boolean {
  try {
    store.updateSettingsDurable(patch, { notifyListeners: true })
    return true
  } catch (error) {
    console.error('[agent-catalog] durable authoring write failed:', error)
    return false
  }
}
