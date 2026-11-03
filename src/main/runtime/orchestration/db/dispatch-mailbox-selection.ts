import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isEquivalentPaneKey } from './pane-key-match'

export function activeDispatchMailboxBranch(
  byHandle: readonly unknown[],
  paneKey: string | undefined,
  byExactPane: readonly unknown[] = []
): 'handle' | 'pane' | 'suffix' {
  if (byHandle.length > 0 || !paneKey) {
    return 'handle'
  }
  return byExactPane.length > 0 || !parsePaneKey(paneKey) ? 'pane' : 'suffix'
}

export function equivalentDispatchMailboxOwners<T extends { assignee_pane_key: string | null }>(
  candidates: T[],
  paneKey: string
): T[] {
  return candidates.filter(
    (dispatch) =>
      dispatch.assignee_pane_key !== null &&
      isEquivalentPaneKey(dispatch.assignee_pane_key, paneKey)
  )
}
