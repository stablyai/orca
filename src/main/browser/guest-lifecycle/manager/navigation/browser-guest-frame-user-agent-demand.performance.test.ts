import type { Session } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ webFrameMain: { fromId: vi.fn() } }))

import {
  clearBrowserGuestUserAgentDemand,
  setBrowserGuestFrameUserAgentDemand,
  setBrowserGuestPageUserAgentDemand
} from '../../../identity/requests/browser-session-ua-demand'
import { noteBrowserGuestSubframeUnloaded } from './browser-guest-frame-user-agent-demand'

afterEach(() => {
  clearBrowserGuestUserAgentDemand(7)
  vi.useRealTimers()
})

function guestWithFrames(count: number): { guest: Electron.WebContents; reads: () => number } {
  let reads = 0
  const frames = Array.from({ length: count }, (_, frameTreeNodeId) => ({ frameTreeNodeId }))
  const guest = {
    id: 7,
    session: {} as Session,
    isDestroyed: () => false,
    mainFrame: {
      get framesInSubtree() {
        reads += 1
        return frames
      }
    }
  } as unknown as Electron.WebContents
  return { guest, reads: () => reads }
}

it.each([100, 1000])(
  'skips the frame-tree walk when a commit cleared iframe demand first (%i frames)',
  (count) => {
    vi.useFakeTimers()
    const { guest, reads } = guestWithFrames(count)
    setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, 5, true)
    noteBrowserGuestSubframeUnloaded(guest, null)
    setBrowserGuestPageUserAgentDemand(guest.session, guest.id, false, 'clear')
    vi.advanceTimersByTime(1000)
    expect(reads()).toBe(0)
  }
)

it.each([100, 1000])(
  'checks only the tracked site iframes, not the whole frame tree (%i frames)',
  (count) => {
    vi.useFakeTimers()
    const { guest, reads } = guestWithFrames(count)
    setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, 3, true)
    setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, 4, true)
    for (let i = 0; i < 20; i += 1) {
      noteBrowserGuestSubframeUnloaded(guest, null)
      vi.advanceTimersByTime(300)
    }
    expect(reads()).toBe(0)
  }
)
