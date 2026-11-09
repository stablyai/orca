import type { DispatchContextRow } from '../../db/orchestration-records'
import { isEquivalentPaneKey } from '../../db/pane-key-match'

type DispatchMailboxTerminal = {
  handle: string
  paneKeys: readonly string[]
}

type DispatchMailboxLookup = {
  getActiveDispatchMailboxOwners?: (
    handle: string,
    paneKey?: string
  ) => readonly DispatchContextRow[]
}

/** Active Dispatches assigned to this terminal whose pane is still this terminal. */
export function liveDispatchMailboxes(
  db: DispatchMailboxLookup,
  terminal: DispatchMailboxTerminal
): DispatchContextRow[] {
  const seen = new Set<string>()
  const found: DispatchContextRow[] = []
  const paneKeys = terminal.paneKeys.length > 0 ? terminal.paneKeys : [undefined]
  for (const paneKey of paneKeys) {
    for (const dispatch of db.getActiveDispatchMailboxOwners?.(terminal.handle, paneKey) ?? []) {
      if (
        seen.has(dispatch.id) ||
        !terminalOwnsDispatchPane(terminal, dispatch.assignee_pane_key)
      ) {
        continue
      }
      seen.add(dispatch.id)
      found.push(dispatch)
    }
  }
  return found
}

function terminalOwnsDispatchPane(
  terminal: DispatchMailboxTerminal,
  assigneePaneKey: string | null
): boolean {
  if (assigneePaneKey === null) {
    return true
  }
  return terminal.paneKeys.some((paneKey) => isEquivalentPaneKey(assigneePaneKey, paneKey))
}
