import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import {
  terminalLeafMovePaneKeys,
  type TerminalLeafMoveRequest
} from '../../../shared/terminal-leaf-move'

/**
 * The persisted physical-key aliases after a move: the pane's process keeps posting the key it
 * spawned under, so that key must route to the new owner. One entry per physical key; a pane that
 * returns to its physical key owns itself and keeps no entry. Mirrors the hook server's transfer.
 */
export function aliasEntriesAfterMove(
  entries: readonly LegacyPaneKeyAliasEntry[],
  move: TerminalLeafMoveRequest,
  ptyId: string,
  updatedAt: number
): LegacyPaneKeyAliasEntry[] {
  const { from, to } = terminalLeafMovePaneKeys(move)
  const reachesFrom = (entry: LegacyPaneKeyAliasEntry): boolean => entry.stablePaneKey === from
  const chained = entries.filter(reachesFrom)
  const physicalKeys = chained.length > 0 ? chained.map((entry) => entry.legacyPaneKey) : [from]
  const kept = entries.filter((entry) => !reachesFrom(entry))
  const moved = physicalKeys
    .filter((legacyPaneKey) => legacyPaneKey !== to)
    .map((legacyPaneKey) => ({ ptyId, legacyPaneKey, stablePaneKey: to, updatedAt }))
  return [...kept, ...moved]
}
