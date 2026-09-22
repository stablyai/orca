import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  paneSpawnReservationsByOwnerKey,
  pendingRuntimePaneCreatesByOwnerKey
} from './spawn-reservation'
import { stablePaneAdoptionsByOwnerKey } from './stable-owner'

export function hasPendingTerminalTabOwner(tabId: string): boolean {
  for (const owners of [
    paneSpawnReservationsByOwnerKey,
    pendingRuntimePaneCreatesByOwnerKey,
    stablePaneAdoptionsByOwnerKey
  ]) {
    for (const ownerKey of owners.keys()) {
      const identity: unknown = JSON.parse(ownerKey)
      if (
        Array.isArray(identity) &&
        identity.length === 3 &&
        typeof identity[2] === 'string' &&
        parsePaneKey(identity[2])?.tabId === tabId
      ) {
        return true
      }
    }
  }
  return false
}
