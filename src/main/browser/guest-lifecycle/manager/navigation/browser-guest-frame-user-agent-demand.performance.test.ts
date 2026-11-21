import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ webFrameMain: { fromId: vi.fn() } }))
vi.mock('../../../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({})
}))
vi.mock('../../../identity/requests/browser-session-ua', () => ({
  browserSessionHeaderListenerIgnoresDemand: () => false
}))
vi.mock('../../../identity/browser-tab-identity', () => ({ resolveBrowserTabIdentity: () => ({}) }))
// Only a Teams address needs a header rewrite here.
vi.mock('./browser-manager-navigation', () => ({
  rewritesRequestHeaders: (url: string) => url.startsWith('https://teams.microsoft.com/')
}))

import {
  clearBrowserGuestUserAgentDemand,
  getBrowserGuestFrameUserAgentDemand,
  setBrowserGuestFrameUserAgentDemand,
  setBrowserGuestPageUserAgentDemand
} from '../../../identity/requests/browser-session-ua-demand'
import {
  countTrackedBrowserGuestFrames,
  noteBrowserGuestSubframeNavigation,
  noteBrowserGuestSubframeUnloaded,
  trackBrowserPopupUserAgentDemand,
  watchBrowserPopupSiteFrameRemoval
} from './browser-guest-frame-user-agent-demand'

afterEach(() => {
  clearBrowserGuestUserAgentDemand(7)
  vi.useRealTimers()
})

function guestWithFrames(count: number): { guest: Electron.WebContents; reads: () => number } {
  let reads = 0
  const frames = Array.from({ length: count }, (_, frameTreeNodeId) => ({ frameTreeNodeId }))
  const fake = {
    id: 7,
    session: {},
    isDestroyed: () => false,
    mainFrame: {
      get framesInSubtree() {
        reads += 1
        return frames
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: has every WebContents member the frame tracker reads.
  const guest = fake as unknown as Electron.WebContents
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: has every WebFrameMain member the frame tracker reads.
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

it('checks an idle popup a fixed number of times, not on a timer for its lifetime', () => {
  vi.useFakeTimers()
  let checks = 0
  const frame = {
    frameTreeNodeId: 3,
    detached: false,
    isDestroyed: () => {
      checks += 1
      return false
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: has every WebContents member the popup tracker reads.
  const popup = Object.assign(new EventEmitter(), {
    id: 7,
    session: {},
    isDestroyed: () => false,
    getURL: () => 'https://login.example.test/'
  }) as unknown as Electron.WebContents
  trackBrowserPopupUserAgentDemand(popup)
  popup.emit('did-start-navigation', {
    url: 'https://teams.microsoft.com/v2/',
    isMainFrame: false,
    frame
  })
  vi.advanceTimersByTime(10 * 60_000)
  // Checks 2, 4, 8 and 16 s apart, then none while the popup sits idle.
  expect(checks).toBe(4)
  expect(vi.getTimerCount()).toBe(0)
})

it('checks a site iframe a popup shows after loading a new page, then clears it once removed', () => {
  vi.useFakeTimers()
  const siteFrame = (frameTreeNodeId: number) => ({
    frameTreeNodeId,
    detached: false,
    isDestroyed: () => false
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: has every WebContents member the popup tracker reads.
  const popup = Object.assign(new EventEmitter(), {
    id: 7,
    session: {},
    isDestroyed: () => false,
    getURL: () => 'https://login.example.test/'
  }) as unknown as Electron.WebContents
  trackBrowserPopupUserAgentDemand(popup)
  const teams = 'https://teams.microsoft.com/v2/'
  popup.emit('did-start-navigation', { url: teams, isMainFrame: false, frame: siteFrame(3) })
  vi.advanceTimersByTime(60_000)
  // The popup loads another page, which embeds a new Teams iframe.
  popup.emit('did-navigate')
  const next = siteFrame(4)
  popup.emit('did-start-navigation', { url: teams, isMainFrame: false, frame: next })
  expect([...getBrowserGuestFrameUserAgentDemand(7)]).toEqual([4])
  next.detached = true
  vi.advanceTimersByTime(2_500)
  expect([...getBrowserGuestFrameUserAgentDemand(7)]).toEqual([])
})

it.each([100, 1000])(
  'admits a popup subframe navigation in constant work, whatever the watched site iframes (%i)',
  (count) => {
    vi.useFakeTimers()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: has every WebContents member the popup watcher reads.
    const popup = Object.assign(new EventEmitter(), {
      id: 7,
      session: {},
      isDestroyed: () => false
    }) as unknown as Electron.WebContents
    watchBrowserPopupSiteFrameRemoval(popup)
    for (let frameTreeNodeId = 100; frameTreeNodeId < 100 + count; frameTreeNodeId += 1) {
      setBrowserGuestFrameUserAgentDemand(popup.session, popup.id, frameTreeNodeId, true)
      popup.emit('did-start-navigation', { isMainFrame: false, frame: { frameTreeNodeId } })
    }
    const lookups = vi.spyOn(Set.prototype, 'has')
    for (let i = 0; i < 100; i += 1) {
      popup.emit('did-start-navigation', { isMainFrame: false, frame: { frameTreeNodeId: 5 } })
      popup.emit('did-start-navigation', { isMainFrame: false, frame: { frameTreeNodeId: 100 } })
    }
    // One or two set lookups per event, not one per watched iframe.
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(400)
    lookups.mockRestore()
  }
)
