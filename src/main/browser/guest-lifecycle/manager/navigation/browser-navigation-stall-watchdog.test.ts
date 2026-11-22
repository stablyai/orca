import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  answerBrowserSessionBeforeRequest,
  setBrowserSessionRequestDecider,
  watchDecisionBlockedMainFrames
} from '../../../sessions/requests/browser-session-request-decisions'
import { reportBrowserSessionWebRequest } from '../../../sessions/requests/browser-session-web-request-observer'
import {
  BROWSER_LOAD_STALL_AFTER_MS,
  installBrowserNavigationStallWatchdog
} from './browser-navigation-stall-watchdog'

const GUEST_ID = 41
// An extension's decision per main-frame request, settled when the test blocks it.
const pendingDecisions = new Map<number, () => void>()

beforeEach(() => {
  vi.useFakeTimers()
  setBrowserSessionRequestDecider({
    beforeRequest: (_session, details) =>
      new Promise((resolve) => pendingDecisions.set(details.id, () => resolve({ cancel: true }))),
    beforeSendHeaders: (_session, _details, headers) => headers,
    headersReceived: () => null
  })
})

afterEach(() => {
  setBrowserSessionRequestDecider(null)
  pendingDecisions.clear()
  vi.useRealTimers()
})

type FakeGuest = EventEmitter & { session: Electron.Session }

function fakeGuest(): FakeGuest {
  const guest = Object.assign(new EventEmitter(), {
    id: GUEST_ID,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watchdog only compares session identity.
    session: {} as Electron.Session,
    mainFrame: { processId: 1, routingId: 1 },
    getURL: () => 'about:blank',
    isDestroyed: () => false,
    // An iframe keeps the page loading, so did-stop-loading never ends a watch here.
    isLoadingMainFrame: () => true
  })
  return guest
}

function watch(guest: FakeGuest): { reports: unknown[]; dispose: () => void } {
  const reports: unknown[] = []
  const dispose = installBrowserNavigationStallWatchdog(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: emitter with every WebContents member the watchdog reads.
    guest as unknown as Electron.WebContents,
    (stall) => reports.push(stall)
  )
  // The guest policy reports an extension block as a main-frame load failure.
  const stopBlocks = watchDecisionBlockedMainFrames(GUEST_ID, (url) =>
    guest.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', url, true)
  )
  return {
    reports,
    dispose: () => {
      stopBlocks()
      dispose()
    }
  }
}

function navigate(guest: FakeGuest, requestId: number, url: string): void {
  guest.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
  const details = {
    id: requestId,
    url,
    method: 'GET',
    webContentsId: GUEST_ID,
    resourceType: 'mainFrame',
    timestamp: 0
  }
  reportBrowserSessionWebRequest(guest.session, 'onBeforeRequest', details)
  answerBrowserSessionBeforeRequest(
    guest.session,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carries every field the decision path reads.
    details as Electron.OnBeforeRequestListenerDetails,
    () => {}
  )
}

async function block(requestId: number): Promise<void> {
  pendingDecisions.get(requestId)?.()
  await vi.advanceTimersByTimeAsync(0)
}

it('keeps watching a newer load when the navigation it replaced is blocked late', async () => {
  const guest = fakeGuest()
  const { reports, dispose } = watch(guest)
  navigate(guest, 1, 'http://first.test/a')
  navigate(guest, 2, 'http://second.test/b')
  await block(1)
  vi.advanceTimersByTime(BROWSER_LOAD_STALL_AFTER_MS)
  expect(reports).toEqual([{ phase: 'held', host: 'second.test', hiddenSameOriginPages: 0 }])
  // Its own block ends it, though an iframe keeps the page loading.
  await block(2)
  expect(reports.at(-1)).toBeNull()
  dispose()
})

it('keeps watching a same-URL load when an earlier attempt is blocked after another page committed', async () => {
  const guest = fakeGuest()
  const { reports, dispose } = watch(guest)
  navigate(guest, 1, 'http://site.test/a')
  navigate(guest, 2, 'http://other.test/')
  guest.emit('did-navigate', {}, 'http://other.test/')
  navigate(guest, 3, 'http://site.test/a')
  await block(1)
  vi.advanceTimersByTime(BROWSER_LOAD_STALL_AFTER_MS)
  expect(reports).toEqual([{ phase: 'held', host: 'site.test', hiddenSameOriginPages: 0 }])
  dispose()
})

it('ends a stalled load at its error page while an iframe keeps the page loading', () => {
  const guest = fakeGuest()
  const { reports, dispose } = watch(guest)
  navigate(guest, 1, 'http://down.test/')
  vi.advanceTimersByTime(BROWSER_LOAD_STALL_AFTER_MS)
  expect(reports).toEqual([{ phase: 'held', host: 'down.test', hiddenSameOriginPages: 0 }])
  guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://down.test/', true)
  expect(reports.at(-1)).toBeNull()
  dispose()
})
