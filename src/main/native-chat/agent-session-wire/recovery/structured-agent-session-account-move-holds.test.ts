import { afterEach, expect, it } from 'vitest'
import {
  disposeHeldOnDispatch,
  heldOnDispatch
} from './structured-agent-session-account-move-holds.test-fixture'

afterEach(disposeHeldOnDispatch)

it('keeps no hold on a Dispatch that ended before the hold was listed', () => {
  expect(heldOnDispatch(1).held('chat-0')).toBe(true)
  disposeHeldOnDispatch()
  // Its end was reported between the read and the listing, so no edge will come for it.
  expect(heldOnDispatch(1, false).held('chat-0')).toBe(false)
})
