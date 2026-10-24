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
import {
  checkBrowserLocalNetworkAccess,
  requestBrowserLocalNetworkAccess
} from './browser-local-network-access'
import { clearLocalNetworkGrants } from './browser-local-network-grants'
import { BROWSER_PAGE_PROMPT_TIMEOUT_MS, respondToBrowserPagePrompt } from './browser-page-prompts'

type MockGuest = Electron.WebContents & EventEmitter

const PARTITION = 'persist:browsing-1'
const guests: MockGuest[] = []

function mockGuest(pageUrl = 'https://acme.okta.com/signin'): MockGuest {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt only reads id, isDestroyed, getURL and the navigation and destroyed events.
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

function sentRequests(renderer: Electron.WebContents): BrowserPagePromptRequest<'local-network'>[] {
  return vi
    .mocked(renderer.send)
    .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-requested')
    .map(([, request]) => request)
}

function ask(guest: MockGuest, requestingUrl: string | undefined = guest.getURL()) {
  const respond = vi.fn()
  requestBrowserLocalNetworkAccess({
    partition: PARTITION,
    requester: guest,
    requestingUrl,
    respond
  })
  return respond
}

const answer = (renderer: Electron.WebContents, requestId: string, value: unknown) =>
  respondToBrowserPagePrompt(renderer, { requestId, answer: value })

const check = (guest: MockGuest, details?: { requestingUrl?: string; embeddingOrigin?: string }) =>
  checkBrowserLocalNetworkAccess({
    partition: PARTITION,
    webContents: guest,
    requestingOrigin: new URL(guest.getURL()).origin,
    details
  })

describe('browser local network access', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.resolvePagePromptTarget.mockReset()
  })

  afterEach(() => {
    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    clearLocalNetworkGrants(PARTITION)
    clearLocalNetworkGrants('persist:browsing-2')
    vi.useRealTimers()
  })

  it('names the asking origin and allows only after the user says yes', async () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const respond = ask(mockGuest())

    const [request] = sentRequests(renderer)
    expect(request).toMatchObject({
      kind: 'local-network',
      details: { origin: 'https://acme.okta.com' }
    })
    expect(respond).not.toHaveBeenCalled()

    await answer(renderer, request.requestId, true)
    expect(respond).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledWith(true)
  })

  it('denies when the user declines, and a later check still reports denied', async () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const guest = mockGuest()
    const respond = ask(guest)

    await answer(renderer, sentRequests(renderer)[0].requestId, null)
    expect(respond).toHaveBeenCalledWith(false)
    expect(check(guest)).toBe(false)
  })

  it('reports the grant through the check handler, per partition and origin', async () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const guest = mockGuest()
    expect(check(guest)).toBe(false)

    ask(guest)
    await answer(renderer, sentRequests(renderer)[0].requestId, true)

    expect(check(guest)).toBe(true)
    expect(
      checkBrowserLocalNetworkAccess({
        partition: 'persist:browsing-2',
        webContents: guest,
        requestingOrigin: 'https://acme.okta.com',
        details: undefined
      })
    ).toBe(false)
    expect(check(mockGuest('https://other.test/'))).toBe(false)
  })

  it('answers later requests from the grant without asking again', async () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const guest = mockGuest()
    ask(guest)
    await answer(renderer, sentRequests(renderer)[0].requestId, true)

    const respond = ask(guest)
    expect(respond).toHaveBeenCalledWith(true)
    expect(sentRequests(renderer)).toHaveLength(1)
  })

  it('denies an answer that arrives after the partition was cleared, and keeps no grant', async () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const guest = mockGuest()
    const respond = ask(guest)

    // Why: SSH teardown closes the guest without waiting and clears the partition at once.
    clearLocalNetworkGrants(PARTITION)
    await answer(renderer, sentRequests(renderer)[0].requestId, true)
    expect(respond).toHaveBeenCalledWith(false)
    expect(check(guest)).toBe(false)
  })

  it('shares one prompt between concurrent requests for the same origin', async () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const guest = mockGuest()
    const first = ask(guest)
    const second = ask(guest)

    const requests = sentRequests(renderer)
    expect(requests).toHaveLength(1)
    await answer(renderer, requests[0].requestId, true)
    expect(first).toHaveBeenCalledWith(true)
    expect(second).toHaveBeenCalledWith(true)
  })

  it('denies http pages, opaque origins and cross-origin frames without asking', () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)

    expect(ask(mockGuest('http://acme.test/'))).toHaveBeenCalledWith(false)
    expect(ask(mockGuest('about:blank'))).toHaveBeenCalledWith(false)
    expect(ask(mockGuest('https://acme.test/'), 'https://ads.test/frame')).toHaveBeenCalledWith(
      false
    )
    expect(ask(mockGuest('https://acme.test/'), '')).toHaveBeenCalledWith(false)
    expect(sentRequests(renderer)).toHaveLength(0)
  })

  it('does not let a cross-origin frame use the top-level page grant', async () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const guest = mockGuest('https://acme.test/')
    ask(guest)
    await answer(renderer, sentRequests(renderer)[0].requestId, true)

    expect(ask(guest, 'https://ads.test/frame')).toHaveBeenCalledWith(false)
    expect(
      check(guest, {
        requestingUrl: 'https://ads.test/frame',
        embeddingOrigin: 'https://acme.test'
      })
    ).toBe(false)
    expect(check(guest, { requestingUrl: 'https://acme.test/frame' })).toBe(true)
  })

  it('denies when the page has no window to ask in', () => {
    mocks.resolvePagePromptTarget.mockReturnValue(null)
    expect(ask(mockGuest())).toHaveBeenCalledWith(false)
  })

  it('denies a pending request when the page goes away', () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const guest = mockGuest()
    const respond = ask(guest)

    guest.emit('destroyed')
    expect(respond).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledWith(false)
    expect(check(guest)).toBe(false)
  })

  it('denies a pending request when the page navigates away', () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const guest = mockGuest()
    const respond = ask(guest)

    guest.emit('did-navigate')
    expect(respond).toHaveBeenCalledWith(false)
  })

  it('ignores a reply that is not a plain yes', async () => {
    const renderer = mockRenderer(1)
    showTabIn(renderer)
    const respond = ask(mockGuest())
    const [request] = sentRequests(renderer)

    expect(await answer(renderer, request.requestId, 'yes')).toBe('rejected')
    expect(respond).not.toHaveBeenCalled()
  })

  describe("permission query (Electron turns Chromium's own local network checks off)", () => {
    it('asks on a query from an eligible page and reports the grant on the next one', async () => {
      const renderer = mockRenderer(1)
      showTabIn(renderer)
      const guest = mockGuest()

      expect(check(guest)).toBe(false)
      const [request] = sentRequests(renderer)
      expect(request).toMatchObject({ details: { origin: 'https://acme.okta.com' } })
      // Repeated queries while the prompt is open share it.
      expect(check(guest)).toBe(false)
      expect(sentRequests(renderer)).toHaveLength(1)

      await answer(renderer, request.requestId, true)
      expect(check(guest)).toBe(true)
    })

    it('asks on the Electron 43 main-frame details shape, which carries embeddingOrigin', async () => {
      const renderer = mockRenderer(1)
      showTabIn(renderer)
      const guest = mockGuest('https://example.com/')
      const details = {
        embeddingOrigin: 'https://example.com/',
        isMainFrame: true,
        requestingUrl: 'https://example.com/'
      }

      expect(check(guest, details)).toBe(false)
      const [request] = sentRequests(renderer)
      expect(request).toMatchObject({ details: { origin: 'https://example.com' } })

      await answer(renderer, request.requestId, true)
      expect(check(guest, details)).toBe(true)
    })

    it('does not ask for a cross-origin subframe whose embeddingOrigin differs', () => {
      const renderer = mockRenderer(1)
      showTabIn(renderer)
      const guest = mockGuest('https://b.example/')

      expect(
        check(guest, { requestingUrl: 'https://a.example/', embeddingOrigin: 'https://b.example/' })
      ).toBe(false)
      expect(sentRequests(renderer)).toHaveLength(0)
    })

    it('does not ask again after a decline until the user acts in the page', async () => {
      const renderer = mockRenderer(1)
      showTabIn(renderer)
      const guest = mockGuest()
      check(guest)
      await answer(renderer, sentRequests(renderer)[0].requestId, null)

      expect(check(guest)).toBe(false)
      expect(sentRequests(renderer)).toHaveLength(1)
    })

    it('never asks for http pages, cross-origin frames or checks without a page', () => {
      const renderer = mockRenderer(1)
      showTabIn(renderer)

      expect(check(mockGuest('http://acme.test/'))).toBe(false)
      expect(
        check(mockGuest('https://acme.test/'), {
          requestingUrl: 'https://ads.test/frame',
          embeddingOrigin: 'https://acme.test'
        })
      ).toBe(false)
      expect(
        checkBrowserLocalNetworkAccess({
          partition: PARTITION,
          webContents: null,
          requestingOrigin: 'https://acme.test',
          details: undefined
        })
      ).toBe(false)
      expect(sentRequests(renderer)).toHaveLength(0)
    })
  })
})
