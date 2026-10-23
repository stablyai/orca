import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolvePagePromptTarget: vi.fn()
}))

vi.mock('./browser-manager', () => ({
  browserManager: {
    resolvePagePromptTarget: mocks.resolvePagePromptTarget
  }
}))

import type { BrowserPagePromptRequest } from '../../shared/browser-page-prompt'
import { handleBrowserGuestLogin } from './browser-http-auth-prompt'
import { BROWSER_PAGE_PROMPT_TIMEOUT_MS, respondToBrowserPagePrompt } from './browser-page-prompts'

type MockGuest = Electron.WebContents & EventEmitter

const guests: MockGuest[] = []

function mockGuest(pageUrl = 'https://staging.acme.com/'): MockGuest {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt only reads id, isDestroyed, getURL and the input, navigation and destroyed events.
  const guest = new EventEmitter() as MockGuest
  Object.assign(guest, {
    id: 100 + guests.length,
    isDestroyed: () => false,
    getURL: () => pageUrl
  })
  guests.push(guest)
  return guest
}

function mockRenderer(id: number): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed, send and subscribe to the window's lifecycle events.
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  } as unknown as Electron.WebContents
}

function showTabIn(renderer: Electron.WebContents, browserPageId = 'page-1'): void {
  mocks.resolvePagePromptTarget.mockReturnValue({ browserPageId, renderer })
}

function challenge(
  guest: MockGuest,
  {
    url = 'https://staging.acme.com/',
    isRequestForNavigation = true,
    firstAuthAttempt = true,
    isProxy = false,
    realm = 'Staging'
  } = {}
) {
  const event = { preventDefault: vi.fn() }
  const callback = vi.fn()
  handleBrowserGuestLogin(
    event,
    guest,
    { url, pid: 1, isRequestForNavigation, firstAuthAttempt },
    { isProxy, scheme: 'basic', host: new URL(url).hostname, port: 443, realm },
    callback
  )
  return { asked: event.preventDefault.mock.calls.length > 0, callback }
}

function sentRequests(renderer: Electron.WebContents): BrowserPagePromptRequest<'http-auth'>[] {
  return vi
    .mocked(renderer.send)
    .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-requested')
    .map(([, request]) => request)
}

const answer = (renderer: Electron.WebContents, requestId: string, value: unknown) =>
  respondToBrowserPagePrompt(renderer, { requestId, answer: value })

const CREDENTIALS = { username: 'qa', password: 'hunter2' }

describe('browser HTTP auth prompt', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.resolvePagePromptTarget.mockReset()
  })

  afterEach(() => {
    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    for (const guest of guests.splice(0)) {
      guest.emit('destroyed')
    }
    vi.useRealTimers()
  })

  it('asks the window showing the tab, and signs in or cancels with the answer', async () => {
    const renderer = mockRenderer(10)
    showTabIn(renderer)
    const guest = mockGuest()

    const signIn = challenge(guest)

    expect(signIn.asked).toBe(true)
    const [request] = sentRequests(renderer)
    expect(request).toMatchObject({
      kind: 'http-auth',
      details: { origin: 'https://staging.acme.com', retry: false }
    })
    await expect(answer(renderer, request.requestId, { username: 'qa' })).resolves.toBe('rejected')
    expect(signIn.callback).not.toHaveBeenCalled()
    await expect(answer(renderer, request.requestId, CREDENTIALS)).resolves.toBe('answered')
    expect(signIn.callback).toHaveBeenCalledWith('qa', 'hunter2')

    // The site turned the password down, so the next question says so.
    const retry = challenge(guest, { firstAuthAttempt: false })
    const [, retryRequest] = sentRequests(renderer)
    expect(retryRequest.details.retry).toBe(true)
    await answer(renderer, retryRequest.requestId, null)
    // Called with no credentials, Electron cancels and the page shows the site's 401 page.
    expect(retry.callback).toHaveBeenCalledWith()
  })

  it.each([
    ['a proxy challenge', { isProxy: true }],
    [
      'an image from another site',
      { url: 'https://cdn.other.com/a.png', isRequestForNavigation: false }
    ]
  ])('leaves %s to Electron, which cancels it', (_name, options) => {
    const renderer = mockRenderer(10)
    showTabIn(renderer)

    const { asked } = challenge(mockGuest(), options)

    expect(asked).toBe(false)
    expect(sentRequests(renderer)).toEqual([])
  })

  it('asks for a same-site request the page makes', () => {
    const renderer = mockRenderer(10)
    showTabIn(renderer)

    const { asked } = challenge(mockGuest(), {
      url: 'https://staging.acme.com/api/me',
      isRequestForNavigation: false
    })

    expect(asked).toBe(true)
    expect(sentRequests(renderer)).toHaveLength(1)
  })

  it('shares one prompt per realm and cancels a different challenge meanwhile', async () => {
    const renderer = mockRenderer(10)
    showTabIn(renderer)
    const guest = mockGuest()

    const first = challenge(guest)
    const sameRealm = challenge(guest, {
      url: 'https://staging.acme.com/logo.png',
      isRequestForNavigation: false
    })
    const otherRealm = challenge(guest, { realm: 'Admin' })

    expect([first.asked, sameRealm.asked, otherRealm.asked]).toEqual([true, true, false])
    const [request] = sentRequests(renderer)
    expect(sentRequests(renderer)).toHaveLength(1)
    await answer(renderer, request.requestId, CREDENTIALS)
    expect(first.callback).toHaveBeenCalledWith('qa', 'hunter2')
    expect(sameRealm.callback).toHaveBeenCalledWith('qa', 'hunter2')
  })
})
