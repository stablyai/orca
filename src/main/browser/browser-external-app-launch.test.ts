import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getApplicationNameForProtocol: vi.fn((_url: string) => 'Okta Verify'),
  openExternal: vi.fn((_url: string) => Promise.resolve())
}))

vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: mocks.getApplicationNameForProtocol },
  shell: { openExternal: mocks.openExternal }
}))

import type { BrowserExternalAppRequest } from '../../shared/browser-external-app'
import {
  BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS,
  cancelBrowserExternalAppRequests,
  requestBrowserExternalAppLaunch,
  respondToBrowserExternalAppRequest
} from './browser-external-app-launch'

const OKTA_URL = 'com-okta-authenticator:/deviceChallenge?challengeRequest=abc'

function mockRenderer(id: number): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher only reads id, isDestroyed and send.
  return { id, isDestroyed: () => false, send: vi.fn() } as unknown as Electron.WebContents
}

const requesters: (Electron.WebContents & EventEmitter)[] = []

/** The page contents that asks; only its id, liveness and input events matter to the launcher. */
function mockRequester(): Electron.WebContents & EventEmitter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher only reads id, isDestroyed and the input and destroyed events.
  const contents = new EventEmitter() as Electron.WebContents & EventEmitter
  Object.assign(contents, { id: 1000 + requesters.length, isDestroyed: () => false })
  requesters.push(contents)
  return contents
}

const pageRequesters = new Map<string, Electron.WebContents & EventEmitter>()

function ask(renderer: Electron.WebContents, rawUrl = OKTA_URL, browserPageId = 'page-1') {
  let requester = pageRequesters.get(browserPageId)
  if (!requester) {
    requester = mockRequester()
    pageRequesters.set(browserPageId, requester)
  }
  return requestBrowserExternalAppLaunch({
    context: { browserPageId, renderer },
    requester,
    rawUrl,
    requestingUrl: () => 'https://acme.okta.com/signin'
  })
}

function sentRequests(renderer: Electron.WebContents): BrowserExternalAppRequest[] {
  return vi
    .mocked(renderer.send)
    .mock.calls.filter(([channel]) => channel === 'browser:external-app-requested')
    .map(([, request]) => request)
}

describe('browser external app launch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.openExternal.mockClear()
  })

  afterEach(() => {
    // Expire anything a test left open, then retire every page so no state leaks between tests.
    vi.advanceTimersByTime(BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS)
    for (const requester of requesters.splice(0)) {
      requester.emit('destroyed')
    }
    pageRequesters.clear()
    vi.useRealTimers()
  })

  it('asks the window showing the page and opens the app only after a yes', async () => {
    const renderer = mockRenderer(10)

    expect(ask(renderer)).toBe(true)
    const [request] = sentRequests(renderer)
    expect(vi.mocked(renderer.send).mock.calls[0][0]).toBe('browser:external-app-requested')
    expect(request).toEqual({
      requestId: expect.any(String),
      appName: process.platform === 'linux' ? null : 'Okta Verify',
      scheme: 'com-okta-authenticator',
      origin: 'https://acme.okta.com'
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()

    await expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: request.requestId, open: true })
    ).resolves.toBe('answered')
    expect(mocks.openExternal).toHaveBeenCalledWith(OKTA_URL)

    expect(ask(renderer, 'zoommtg://zoom.us/join?confno=1')).toBe(true)
    const [, declined] = sentRequests(renderer)
    respondToBrowserExternalAppRequest(renderer, { requestId: declined.requestId, open: false })
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://example.com/',
    'http://localhost:3000/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'blob:https://example.com/id',
    'about:blank',
    'orca-preview://doc/index.html',
    'shell:startup',
    'vbscript:msgbox(1)',
    'hcp://system/sysinfo',
    'ms-help://topic',
    'afp://share.example/volume',
    'not a url'
  ])('refuses %s without asking', (rawUrl) => {
    const renderer = mockRenderer(20)
    expect(ask(renderer, rawUrl)).toBe(false)
    expect(renderer.send).not.toHaveBeenCalled()
  })

  it('names no site when the asking frame is unknown', () => {
    const renderer = mockRenderer(40)
    requestBrowserExternalAppLaunch({
      context: { browserPageId: 'page-4', renderer },
      requester: mockRequester(),
      rawUrl: OKTA_URL,
      requestingUrl: () => null
    })
    expect(sentRequests(renderer)[0].origin).toBeNull()
  })

  it('refuses a page with no window on this computer', () => {
    expect(
      requestBrowserExternalAppLaunch({
        context: null,
        requester: mockRequester(),
        rawUrl: OKTA_URL,
        requestingUrl: () => null
      })
    ).toBe(false)
  })

  it('keeps one prompt per page and accepts each answer once, from its own window', async () => {
    const renderer = mockRenderer(30)
    const otherWindow = mockRenderer(31)

    ask(renderer)
    // A page looping a deep link gets no second dialog while the first is open.
    expect(ask(renderer)).toBe(true)
    ask(renderer, OKTA_URL, 'page-2')
    const [first, otherPage] = sentRequests(renderer)
    expect(sentRequests(renderer)).toHaveLength(2)

    await expect(
      respondToBrowserExternalAppRequest(otherWindow, { requestId: first.requestId, open: true })
    ).resolves.toBe('rejected')
    await expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: first.requestId, open: true })
    ).resolves.toBe('answered')
    await expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: first.requestId, open: true })
    ).resolves.toBe('rejected')
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS)
    // An expired request closes its prompt, so no dead Open button is left on screen.
    expect(renderer.send).toHaveBeenCalledWith('browser:external-app-request-closed', {
      requestId: otherPage.requestId
    })
    await expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: otherPage.requestId, open: true })
    ).resolves.toBe('rejected')
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
  })

  it('reports a launch the OS could not start, so the window can say so', async () => {
    const renderer = mockRenderer(70)
    mocks.openExternal.mockRejectedValueOnce(new Error('no application for scheme'))
    ask(renderer, 'zoommtg://zoom.us/join?confno=1', 'page-8')

    await expect(
      respondToBrowserExternalAppRequest(renderer, {
        requestId: sentRequests(renderer)[0].requestId,
        open: true
      })
    ).resolves.toBe('launch-failed')
  })

  it('keeps a refused page quiet until the user clicks or types in it', () => {
    const renderer = mockRenderer(50)

    ask(renderer)
    respondToBrowserExternalAppRequest(renderer, {
      requestId: sentRequests(renderer)[0].requestId,
      open: false
    })
    // A page looping a deep link cannot reopen the app-modal prompt after Cancel.
    expect(ask(renderer)).toBe(true)
    pageRequesters.get('page-1')?.emit('input-event', {}, { type: 'mouseMove' })
    expect(ask(renderer)).toBe(true)
    expect(sentRequests(renderer)).toHaveLength(1)

    pageRequesters.get('page-1')?.emit('input-event', {}, { type: 'mouseDown' })
    ask(renderer)
    expect(sentRequests(renderer)).toHaveLength(2)

    // Ignoring the prompt until it expires counts as a refusal too.
    vi.advanceTimersByTime(BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS)
    ask(renderer)
    expect(sentRequests(renderer)).toHaveLength(2)
    pageRequesters.get('page-1')?.emit('input-event', {}, { type: 'keyDown' })
    ask(renderer)
    expect(sentRequests(renderer)).toHaveLength(3)

    // Saying yes never silences the page.
    respondToBrowserExternalAppRequest(renderer, {
      requestId: sentRequests(renderer)[2].requestId,
      open: true
    })
    ask(renderer)
    expect(sentRequests(renderer)).toHaveLength(4)
  })

  it('closes the prompt when its page goes away, so Open cannot launch for it', async () => {
    const renderer = mockRenderer(60)
    ask(renderer, OKTA_URL, 'page-6')
    ask(renderer, OKTA_URL, 'page-7')
    const [closedPage, livePage] = sentRequests(renderer)

    cancelBrowserExternalAppRequests('page-6')

    expect(renderer.send).toHaveBeenCalledWith('browser:external-app-request-closed', {
      requestId: closedPage.requestId
    })
    await expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: closedPage.requestId, open: true })
    ).resolves.toBe('rejected')
    await expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: livePage.requestId, open: true })
    ).resolves.toBe('answered')
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
  })
})
