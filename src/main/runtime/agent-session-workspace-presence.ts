import { createConditionalWorkspaceMatcher } from './conditional-workspace-presence'

type PresenceState = {
  records: ReadonlyMap<string, { location: { workspaceId: string; executionHostId: string } }>
  unreadableRecords: { readonly size: number }
}

export function agentSessionWorkspacePresence(
  state: PresenceState,
  readOnly: boolean,
  workspaceId: string,
  executionHostId = 'local'
): 'present' | 'absent' | 'unknown' {
  if (readOnly || state.unreadableRecords.size > 0 || state.records.size > 10000) {
    return 'unknown'
  }
  const match = createConditionalWorkspaceMatcher(workspaceId, executionHostId)
  for (const record of state.records.values()) {
    const presence = match(record.location.workspaceId, record.location.executionHostId)
    if (presence === 'same') {
      return 'present'
    }
    if (presence === 'unknown') {
      return 'unknown'
    }
  }
  return 'absent'
}
