import { expect, it } from 'vitest'
import { mobileSessionRouteTarget } from './mobile-session-route'

it('names each pane request with its own intent, and leaves other session opens without one', () => {
  const pane = { hostId: 'desk', worktreeId: 'wt', paneKey: 'pane-1' }
  const first = mobileSessionRouteTarget(pane).params.paneIntent
  expect(first).toBeTruthy()
  expect(mobileSessionRouteTarget(pane).params.paneIntent).not.toBe(first)
  expect(mobileSessionRouteTarget({ hostId: 'desk', worktreeId: 'wt' }).params.paneIntent).toBe(
    undefined
  )
})
