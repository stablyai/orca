import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getRendererContextForGuestMock } = vi.hoisted(() => ({
  getRendererContextForGuestMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: {}
}))

vi.mock('./browser-manager', () => ({
  browserManager: { getRendererContextForGuest: getRendererContextForGuestMock }
}))

import {
  BROWSER_BASIC_AUTH_PROMPT_TIMEOUT_MS,
  cancelAllBrowserBasicAuthRequests,
  cancelBrowserBasicAuthRequests,
  handleBrowserBasicAuthLogin,
  respondToBrowserBasicAuthRequest
} from './browser-basic-auth-prompt'

function mockWebContents(id: number): Electron.WebContents & EventEmitter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EventEmitter stand-in satisfies the two members the prompt touches (event emitter + send).
  const contents = new EventEmitter() as Electron.WebContents & EventEmitter
  Object.assign(contents, {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  })
  return contents
}

function lastSentRequestId(renderer: Electron.WebContents & EventEmitter): string {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mockWebContents installs vi.fn() as send; this reads its recorded calls.
  const send = renderer.send as ReturnType<typeof vi.fn>
  return send.mock.calls[0][1].requestId
}

function rendererContextFor(
  _guest: Electron.WebContents,
  renderer: Electron.WebContents
): {
  renderer: Electron.WebContents
  browserPageId: string
} {
  return { renderer, browserPageId: 'browser-page-1' }
}

describe('browser basic auth prompt', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getRendererContextForGuestMock.mockReset()
  })

  afterEach(() => {
    cancelAllBrowserBasicAuthRequests()
    vi.useRealTimers()
  })

  it('prompts the owning renderer and passes submitted credentials to the login callback', () => {
    const guest = mockWebContents(10)
    const renderer = mockWebContents(20)
    getRendererContextForGuestMock.mockReturnValue(rendererContextFor(guest, renderer))
    const callback = vi.fn()
    const event = { preventDefault: vi.fn() }

    handleBrowserBasicAuthLogin(
      event,
      guest,
      { url: 'http://127.0.0.1:8765/private' },
      { host: '127.0.0.1', port: 8765, realm: 'OrcaTestRealm' },
      callback
    )

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(renderer.send).toHaveBeenCalledWith(
      'browser:basic-auth-requested',
      expect.objectContaining({
        browserPageId: 'browser-page-1',
        host: '127.0.0.1',
        port: 8765,
        protocol: 'http',
        realm: 'OrcaTestRealm'
      })
    )
    expect(callback).not.toHaveBeenCalled()

    expect(
      respondToBrowserBasicAuthRequest(renderer, {
        requestId: lastSentRequestId(renderer),
        cancelled: false,
        username: 'ada',
        password: 'hunter2'
      })
    ).toBe(true)
    expect(callback).toHaveBeenCalledWith('ada', 'hunter2')
  })

  it('cancels with an empty callback when the renderer dismisses the prompt', () => {
    const guest = mockWebContents(10)
    const renderer = mockWebContents(20)
    getRendererContextForGuestMock.mockReturnValue(rendererContextFor(guest, renderer))
    const callback = vi.fn()

    handleBrowserBasicAuthLogin(
      { preventDefault: vi.fn() },
      guest,
      { url: 'https://example.com/signin' },
      { host: 'example.com', port: 443 },
      callback
    )
    const requestId = lastSentRequestId(renderer)

    expect(respondToBrowserBasicAuthRequest(renderer, { requestId, cancelled: true })).toBe(true)
    expect(callback).toHaveBeenCalledWith()
  })

  it('ignores replies from a renderer that does not own the request', () => {
    const guest = mockWebContents(10)
    const renderer = mockWebContents(20)
    getRendererContextForGuestMock.mockReturnValue(rendererContextFor(guest, renderer))
    const callback = vi.fn()

    handleBrowserBasicAuthLogin(
      { preventDefault: vi.fn() },
      guest,
      { url: 'https://example.com/signin' },
      { host: 'example.com', port: 443 },
      callback
    )
    const requestId = lastSentRequestId(renderer)

    expect(
      respondToBrowserBasicAuthRequest(mockWebContents(99), {
        requestId,
        cancelled: false,
        username: 'ada',
        password: 'hunter2'
      })
    ).toBe(false)
    expect(callback).not.toHaveBeenCalled()
  })

  it('times out with an empty callback so the request fails as before the prompt existed', () => {
    const guest = mockWebContents(10)
    const renderer = mockWebContents(20)
    getRendererContextForGuestMock.mockReturnValue(rendererContextFor(guest, renderer))
    const callback = vi.fn()

    handleBrowserBasicAuthLogin(
      { preventDefault: vi.fn() },
      guest,
      { url: 'https://example.com/signin' },
      { host: 'example.com', port: 443 },
      callback
    )
    vi.advanceTimersByTime(BROWSER_BASIC_AUTH_PROMPT_TIMEOUT_MS)

    expect(callback).toHaveBeenCalledWith()
    expect(renderer.send).toHaveBeenCalledWith('browser:basic-auth-request-closed', {
      requestId: expect.any(String)
    })
  })

  it('leaves the request failing untouched when no owning renderer exists', () => {
    const guest = mockWebContents(10)
    getRendererContextForGuestMock.mockReturnValue(undefined)
    const callback = vi.fn()
    const event = { preventDefault: vi.fn() }

    handleBrowserBasicAuthLogin(
      event,
      guest,
      { url: 'https://example.com/signin' },
      { host: 'example.com', port: 443 },
      callback
    )

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })

  it('cancels pending prompts when the browser page unregisters', () => {
    const guest = mockWebContents(10)
    const renderer = mockWebContents(20)
    getRendererContextForGuestMock.mockReturnValue(rendererContextFor(guest, renderer))
    const callback = vi.fn()

    handleBrowserBasicAuthLogin(
      { preventDefault: vi.fn() },
      guest,
      { url: 'https://example.com/signin' },
      { host: 'example.com', port: 443 },
      callback
    )
    cancelBrowserBasicAuthRequests('browser-page-1')

    expect(callback).toHaveBeenCalledWith()
  })
})
