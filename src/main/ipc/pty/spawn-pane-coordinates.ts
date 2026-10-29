import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../shared/terminal-tab-id'
import { makePaneSpawnReservationKey } from './pane/spawn-reservation'

type PtySpawnPaneCoordinates = {
  tabId?: unknown
  leafId?: unknown
  worktreeId?: string
  connectionId?: string | null
}

export function resolveEarlyPaneKey(args: PtySpawnPaneCoordinates): string | null {
  return typeof args.tabId === 'string' &&
    isValidTerminalTabId(args.tabId) &&
    args.tabId.length <= 512 &&
    typeof args.leafId === 'string' &&
    isTerminalLeafId(args.leafId)
    ? makePaneKey(args.tabId, args.leafId)
    : null
}

export function resolveEarlyPaneSpawnReservationKey(args: PtySpawnPaneCoordinates): string | null {
  return makePaneSpawnReservationKey(args.worktreeId, args.connectionId, resolveEarlyPaneKey(args))
}
