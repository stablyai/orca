import { afterEach, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../../../../shared/workspace-sleep'
import { adoptStablePane } from './adopt-stable'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey,
  rejectPaneSpawnReservation,
  reservePaneSpawn
} from './spawn-reservation'

const pane = {
  worktreeId: 'repo::/w',
  connectionId: null,
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111'
}
const ownerKey = makePaneSpawnReservationKey(
  pane.worktreeId,
  null,
  makePaneKey(pane.tabId, pane.leafId)
)!

afterEach(() => paneSpawnReservationsByOwnerKey.clear())

it('does not hand an automatic refusal to a user adoption of the same pane', async () => {
  const reservation = reservePaneSpawn(ownerKey)
  const adopted = adoptStablePane(undefined, undefined, { ...pane, cols: 80, rows: 24 })
  rejectPaneSpawnReservation(ownerKey, reservation, new Error(WORKTREE_TERMINALS_SLEEPING_ERROR))
  await expect(adopted).resolves.toBeNull()
})
