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

function fakeGuest(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    id: 41,
    session: {},
    getURL: () => 'about:blank',
    isDestroyed: () => false,
    isLoadingMainFrame: () => true
  })
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

it('keeps watching a newer load when the navigation it replaced fails late', () => {
  const guest = fakeGuest()
  const { reports, dispose } = watch(guest)
  startNavigation(guest, 'http://first.test/a')
  startNavigation(guest, 'http://second.test/b')
  // The replaced navigation's delayed block arrives after the new one started.
  guest.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', 'http://first.test/a', true)
  vi.advanceTimersByTime(BROWSER_LOAD_STALL_AFTER_MS)
  expect(reports).toEqual([
    { phase: 'no-request-seen', host: 'second.test', hiddenSameOriginPages: 0 }
  ])
  guest.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'http://second.test/b', true)
  expect(reports.at(-1)).toBeNull()
  dispose()
})

it('keeps watching a reload when the attempt it replaced at the same URL fails late', () => {
  const guest = fakeGuest()
  const { reports, dispose } = watch(guest)
  startNavigation(guest, 'http://site.test/a')
  startNavigation(guest, 'http://site.test/a')
  guest.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', 'http://site.test/a', true)
  vi.advanceTimersByTime(BROWSER_LOAD_STALL_AFTER_MS)
  expect(reports).toEqual([
    { phase: 'no-request-seen', host: 'site.test', hiddenSameOriginPages: 0 }
  ])
  guest.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'http://site.test/a', true)
  expect(reports.at(-1)).toBeNull()
  dispose()
})
