import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  BROWSER_LOAD_STALL_AFTER_MS,
  installBrowserNavigationStallWatchdog
} from './browser-navigation-stall-watchdog'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function startNavigation(guest: EventEmitter, url: string): void {
  guest.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
}

type FakeGuest = EventEmitter & { loadingMainFrame: boolean }

function fakeGuest(): FakeGuest {
  const guest = Object.assign(new EventEmitter(), {
    id: 41,
    session: {},
    loadingMainFrame: true,
    getURL: () => 'about:blank',
    isDestroyed: () => false,
    isLoadingMainFrame: () => guest.loadingMainFrame
  })
  return guest
}

function watch(guest: EventEmitter): { reports: unknown[]; dispose: () => void } {
  const reports: unknown[] = []
  const dispose = installBrowserNavigationStallWatchdog(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: emitter with every WebContents member the watchdog reads.
    guest as unknown as Electron.WebContents,
    (stall) => reports.push(stall)
  )
  return { reports, dispose }
}

function lateBlock(guest: EventEmitter, url: string): void {
  guest.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', url, true)
}

it('keeps watching a newer load when the navigation it replaced fails late', () => {
  const guest = fakeGuest()
  const { reports, dispose } = watch(guest)
  startNavigation(guest, 'http://first.test/a')
  startNavigation(guest, 'http://second.test/b')
  lateBlock(guest, 'http://first.test/a')
  vi.advanceTimersByTime(BROWSER_LOAD_STALL_AFTER_MS)
  expect(reports).toEqual([
    { phase: 'no-request-seen', host: 'second.test', hiddenSameOriginPages: 0 }
  ])
  // The stuck load's own failure ends it, even while an iframe keeps the page loading.
  guest.loadingMainFrame = false
  guest.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'http://second.test/b', true)
  vi.advanceTimersByTime(0)
  expect(reports.at(-1)).toBeNull()
  dispose()
})

it('keeps watching a same-URL load when an earlier attempt fails after another page committed', () => {
  const guest = fakeGuest()
  const { reports, dispose } = watch(guest)
  startNavigation(guest, 'http://site.test/a')
  startNavigation(guest, 'http://other.test/')
  guest.emit('did-navigate', {}, 'http://other.test/')
  startNavigation(guest, 'http://site.test/a')
  lateBlock(guest, 'http://site.test/a')
  vi.advanceTimersByTime(BROWSER_LOAD_STALL_AFTER_MS)
  expect(reports).toEqual([
    { phase: 'no-request-seen', host: 'site.test', hiddenSameOriginPages: 0 }
  ])
  dispose()
})
