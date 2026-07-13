export type WorkspaceNameOwner = 'blank' | 'source' | 'user'

export type WorkspaceNameState = {
  value: string
  owner: WorkspaceNameOwner
}

export function createWorkspaceNameState(value = ''): WorkspaceNameState {
  return { value, owner: value.trim() ? 'user' : 'blank' }
}

export function applyManualWorkspaceName(
  _current: WorkspaceNameState,
  value: string
): WorkspaceNameState {
  // Why: even a value equal to the current suggestion is a user decision and
  // must not be overwritten by later source changes.
  return { value, owner: 'user' }
}

export function applySourceWorkspaceName(
  current: WorkspaceNameState,
  suggestedName: string
): { state: WorkspaceNameState; sourceTookOwnership: boolean } {
  if (current.owner === 'user') {
    return { state: current, sourceTookOwnership: false }
  }
  return {
    state: { value: suggestedName, owner: suggestedName.trim() ? 'source' : 'blank' },
    sourceTookOwnership: suggestedName.trim().length > 0
  }
}

export function clearSourceWorkspaceName(current: WorkspaceNameState): WorkspaceNameState {
  return current.owner === 'source' ? { value: '', owner: 'blank' } : current
}
