import type { AgentSessionStoreState } from './agent-session-record-store-file'
export function parseVisibleSessionIds(
  raw: unknown,
  schemaVersion: number,
  currentSchemaVersion: number
): { ids: string[]; present: boolean; valid: boolean } {
  if (raw === undefined) {
    return { ids: [], present: false, valid: true }
  }
  if (!Array.isArray(raw)) {
    return { ids: [], present: false, valid: schemaVersion !== currentSchemaVersion }
  }
  const ids: string[] = []
  for (const value of raw) {
    if (typeof value === 'string' && value.length > 0) {
      ids.push(value)
    } else if (schemaVersion === currentSchemaVersion) {
      return { ids: [], present: true, valid: false }
    }
  }
  return { ids, present: true, valid: true }
}

export function setVisibleSessionId(
  state: AgentSessionStoreState,
  sessionId: string,
  visible: boolean
): void {
  if (visible) {
    if (!state.records.has(sessionId)) {
      throw new Error('agent_session_identity_required')
    }
    state.visibleSessionIds.add(sessionId)
  } else {
    state.visibleSessionIds.delete(sessionId)
  }
  state.visibleSessionIdsIndexPresent = true
}
