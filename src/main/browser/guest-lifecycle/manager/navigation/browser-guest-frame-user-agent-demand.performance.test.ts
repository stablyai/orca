import type { Session } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ webFrameMain: { fromId: vi.fn() } }))
vi.mock('../../../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({})
}))
vi.mock('../../../identity/browser-tab-identity', () => ({ resolveBrowserTabIdentity: () => ({}) }))
// Only a Teams address needs a header rewrite here.
vi.mock('./browser-manager-navigation', () => ({
  rewritesRequestHeaders: (url: string) => url.startsWith('https://teams.microsoft.com/')
}))

import {
  clearBrowserGuestUserAgentDemand,
  setBrowserGuestFrameUserAgentDemand,
  setBrowserGuestPageUserAgentDemand
} from '../../../identity/requests/browser-session-ua-demand'
import {
  countTrackedBrowserGuestFrames,
  noteBrowserGuestSubframeNavigation,
  noteBrowserGuestSubframeUnloaded
} from './browser-guest-frame-user-agent-demand'

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

it.each([30, 300])(
  'keeps tracked site iframes flat across %i page visits with a Teams iframe each',
  (visits) => {
    vi.useFakeTimers()
    const { guest } = guestWithFrames(10)
    let checks = 0
    const siteFrame = (frameTreeNodeId: number) => {
      const frame = {
        frameTreeNodeId,
        detached: false,
        isDestroyed: () => {
          checks += 1
          return false
        }
      }
      return frame as typeof frame & Electron.WebFrameMain
    }
    const teams = 'https://teams.microsoft.com/v2/'
    let nextId = 100
    for (let visit = 0; visit < visits; visit += 1) {
      const frame = siteFrame(nextId++)
      noteBrowserGuestSubframeNavigation(guest, teams, frame)
      vi.advanceTimersByTime(300)
      // The next page commits: its predecessor's iframes are gone.
      frame.detached = true
      setBrowserGuestPageUserAgentDemand(guest.session, guest.id, false, 'clear')
    }
    checks = 0
    // A page with two Teams iframes holds only those two, and its sweep visits only them.
    noteBrowserGuestSubframeNavigation(guest, teams, siteFrame(nextId++))
    noteBrowserGuestSubframeNavigation(guest, teams, siteFrame(nextId++))
    vi.advanceTimersByTime(300)
    expect(countTrackedBrowserGuestFrames(guest)).toBe(2)
    expect(checks).toBe(2)
  }
)
