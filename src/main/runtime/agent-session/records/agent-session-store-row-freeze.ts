import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'

const FREEZE_ROWS = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
}

export function freezeRows(
  state: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites | null
): void {
  if (!FREEZE_ROWS) {
    return
  }
  const records = writes ? writes.records.upsert.map(([key]) => key) : state.records.keys()
  for (const sessionId of records) {
    deepFreeze(state.records.get(sessionId))
  }
  const operations = writes ? writes.operations.upsert.map(([key]) => key) : state.operations.keys()
  for (const key of operations) {
    deepFreeze(state.operations.get(key))
  }
  if (!writes || writes.retiredClaimKeys) {
    state.retiredClaimKeys.forEach(deepFreeze)
  }
}
