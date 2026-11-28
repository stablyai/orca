// Whether a hook-reported pane with no live terminal to decide is a teammate's: one their own
// workspace lists in the teammates' saved partition. Every other pane is the owner's.
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../shared/workspace-layout/stable-pane-id'
import { TEAMMATE_HOMES_SESSION_PARTITION } from '../../../../shared/workspace-session/teammate-homes-session-partition'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

export function teammateListHoldsPane(
  store: Pick<RuntimeStore, 'getWorkspaceSession'> | null,
  paneKey: string
): boolean {
  const tabId = parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId
  const saved = store?.getWorkspaceSession?.(TEAMMATE_HOMES_SESSION_PARTITION).tabsByWorktree
  return (
    tabId !== undefined &&
    Object.values(saved ?? {}).some((tabs) => tabs.some((tab) => tab.id === tabId))
  )
}
