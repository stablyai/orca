import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  answerBrowserSessionBeforeRequest,
  installBrowserSessionHeadersReceived,
  setBrowserSessionRequestDecider,
  watchDecisionBlockedMainFrames,
  type BrowserSessionRequestDecider
} from './browser-session-request-decisions'

import { setBrowserSessionWebRequestObserver } from './browser-session-web-request-observer'

type Listener = (details: unknown, callback: (response: unknown) => void) => void

function fakeSession() {
  const listeners: Record<string, Listener | null> = {}
  const register =
    (event: string) =>
    (...args: unknown[]): void => {
      const listener = args.at(-1)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard only registers a listener function here.
      listeners[event] = typeof listener === 'function' ? (listener as Listener) : null
    }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test touches only these webRequest members.
  const session = {
    webRequest: {
      onBeforeRequest: vi.fn(register('onBeforeRequest')),
      onHeadersReceived: vi.fn(register('onHeadersReceived'))
    }
  } as unknown as Electron.Session
  const fire = (event: string, details: unknown): Promise<unknown> =>
    new Promise((resolve) => listeners[event]?.(details, resolve))
  return { session, fire }
}

function decider(overrides: Partial<BrowserSessionRequestDecider>): BrowserSessionRequestDecider {
  return {
    beforeRequest: () => null,
    beforeSendHeaders: (_session, _details, headers) => headers,
    headersReceived: () => null,
    ...overrides
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a request carries only the fields these handlers read.
const request = {
  id: 1,
  url: 'https://ads.example/a.js',
  method: 'GET',
  resourceType: 'script',
  referrer: '',
  timestamp: 0,
  webContentsId: 3
} as Electron.OnBeforeRequestListenerDetails

afterEach(() => setBrowserSessionRequestDecider(null))

describe('browser session request decisions', () => {
  it('answers with the decision, waits for a held one, and fails open', async () => {
    const { session } = fakeSession()
    const answer = (): Promise<unknown> =>
      new Promise((resolve) => answerBrowserSessionBeforeRequest(session, request, resolve))
    await expect(answer()).resolves.toEqual({})
    setBrowserSessionRequestDecider(decider({ beforeRequest: () => ({ cancel: true }) }))
    await expect(answer()).resolves.toEqual({ cancel: true })
    setBrowserSessionRequestDecider(
      decider({ beforeRequest: async () => ({ redirectURL: 'https://safe.example/' }) })
    )
    await expect(answer()).resolves.toEqual({ redirectURL: 'https://safe.example/' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setBrowserSessionRequestDecider(
      decider({
        beforeRequest: () => {
          throw new Error('boom')
        }
      })
    )
    await expect(answer()).resolves.toEqual({})
  })

  it('tells the guest when the decider blocks its main frame', async () => {
    const { session } = fakeSession()
    const blocked = vi.fn()
    const stop = watchDecisionBlockedMainFrames(3, blocked)
    setBrowserSessionRequestDecider(decider({ beforeRequest: async () => ({ cancel: true }) }))
    const page = { ...request, resourceType: 'mainFrame', url: 'https://blocked.example/' } as const
    await new Promise((resolve) => answerBrowserSessionBeforeRequest(session, page, resolve))
    await new Promise((resolve) => answerBrowserSessionBeforeRequest(session, request, resolve))
    expect(blocked.mock.calls).toEqual([['https://blocked.example/']])
    stop()
    await new Promise((resolve) => answerBrowserSessionBeforeRequest(session, page, resolve))
    expect(blocked).toHaveBeenCalledOnce()
  })

  it('installs one onHeadersReceived that reports to observers and applies the decision', async () => {
    const { session, fire } = fakeSession()
    const observed = vi.fn()
    setBrowserSessionWebRequestObserver(observed)
    installBrowserSessionHeadersReceived(session)
    installBrowserSessionHeadersReceived(session)
    expect(session.webRequest.onHeadersReceived).toHaveBeenCalledOnce()
    await expect(fire('onHeadersReceived', request)).resolves.toEqual({})
    setBrowserSessionRequestDecider(decider({ headersReceived: () => ({ cancel: true }) }))
    await expect(fire('onHeadersReceived', request)).resolves.toEqual({ cancel: true })
    expect(observed).toHaveBeenCalledWith(session, 'onHeadersReceived', request)
  })
})
