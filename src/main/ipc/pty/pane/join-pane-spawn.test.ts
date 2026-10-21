import { afterEach, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../../../runtime/worktree-terminals-sleeping-error'
import { adoptStablePane } from './adopt-stable'
import {
  joinPaneSpawn,
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

it('lets a joiner spawn itself when the owner refused to wake a slept worktree', async () => {
  const reservation = reservePaneSpawn(ownerKey)
  const joined = joinPaneSpawn(reservation)
  rejectPaneSpawnReservation(ownerKey, reservation, new Error(WORKTREE_TERMINALS_SLEEPING_ERROR))
  await expect(joined).resolves.toBeNull()
})

it('still propagates a real spawn failure to joiners', async () => {
  const reservation = reservePaneSpawn(ownerKey)
  const joined = joinPaneSpawn(reservation)
  rejectPaneSpawnReservation(ownerKey, reservation, new Error('spawn_failed'))
  await expect(joined).rejects.toThrow('spawn_failed')
})

it('does not hand an automatic refusal to a user adoption of the same pane', async () => {
  const reservation = reservePaneSpawn(ownerKey)
  const adopted = adoptStablePane(undefined, undefined, { ...pane, cols: 80, rows: 24 })
  rejectPaneSpawnReservation(ownerKey, reservation, new Error(WORKTREE_TERMINALS_SLEEPING_ERROR))
  // No owner exists, so the user's own create proceeds to spawn (and wake) instead of failing.
  await expect(adopted).resolves.toBeNull()
})
