import type { Store } from '../persistence'

export function getKnownWorktreeIdsForHistoryGc(
  store: Pick<Store, 'getAllWorktreeMeta'>
): Set<string> {
  return new Set(Object.keys(store.getAllWorktreeMeta()))
}
