import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { withAgentInputInjection } from '../../cdp/input/agent-input-injection'
import { trackBrowserGuestInputGesture } from './browser-guest-input-gesture'

vi.mock('../../routing/input-ownership/remote-cli-page-admission', () => ({
  assertRemoteCliPageAccess: () => {}
}))

function fakeGuest(): Electron.WebContents & EventEmitter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker and injection scope only use id, events and menu-shortcut toggling.
  return Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    setIgnoreMenuShortcuts: () => {}
  }) as unknown as Electron.WebContents & EventEmitter
}

describe('the gesture behind a popup', () => {
  it("tells an agent's click from the desktop user's", async () => {
    const guest = fakeGuest()
    const gesture = trackBrowserGuestInputGesture(guest)

    await withAgentInputInjection(guest, async () => {
      guest.emit('input-event', {}, { type: 'mouseUp' })
    })
    expect(gesture.consume()).toEqual({ byAgent: true })

    guest.emit('input-event', {}, { type: 'mouseUp' })
    expect(gesture.consume()).toEqual({ byAgent: false })
  })
})
