import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_GUEST_KEYBOARD_FOCUS_TIMEOUT_MS,
  requestBrowserGuestKeyboardFocus,
  respondToBrowserGuestKeyboardFocus
} from './browser-guest-keyboard-focus'

type MockContents = Electron.WebContents & EventEmitter & { send: ReturnType<typeof vi.fn> }

function mockWebContents(id: number, hostWebContents?: Electron.WebContents): MockContents {
  const contents = new EventEmitter() as MockContents
  Object.assign(contents, {
    id,
    hostWebContents,
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    send: vi.fn()
  })
  return contents
}

function sentRequestId(renderer: MockContents): string {
  const [channel, request] = renderer.send.mock.calls[0] ?? []
  expect(channel).toBe('browser:guest-keyboard-focus-requested')
  return (request as { requestId: string }).requestId
}

describe('browser guest keyboard focus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the embedder to focus the guest and resolves with its answer', async () => {
    const renderer = mockWebContents(1)
    const guest = mockWebContents(2, renderer)

    const focused = requestBrowserGuestKeyboardFocus(guest)
    expect(renderer.send).toHaveBeenCalledWith('browser:guest-keyboard-focus-requested', {
      requestId: expect.any(String),
      webContentsId: 2
    })
    expect(
      respondToBrowserGuestKeyboardFocus(renderer, {
        requestId: sentRequestId(renderer),
        focused: false
      })
    ).toBe(true)

    await expect(focused).resolves.toBe('not-on-screen')
  })

  it('ignores an answer from a renderer that was not asked', async () => {
    const renderer = mockWebContents(1)
    const guest = mockWebContents(2, renderer)

    const focused = requestBrowserGuestKeyboardFocus(guest)
    const requestId = sentRequestId(renderer)

    expect(
      respondToBrowserGuestKeyboardFocus(mockWebContents(3), { requestId, focused: true })
    ).toBe(false)
    expect(respondToBrowserGuestKeyboardFocus(renderer, { requestId, focused: true })).toBe(true)
    await expect(focused).resolves.toBe('focused')
  })

  it('resolves null when the embedder never answers', async () => {
    const renderer = mockWebContents(1)
    const focused = requestBrowserGuestKeyboardFocus(mockWebContents(2, renderer))

    vi.advanceTimersByTime(BROWSER_GUEST_KEYBOARD_FOCUS_TIMEOUT_MS)

    await expect(focused).resolves.toBe('unanswered')
    expect(
      respondToBrowserGuestKeyboardFocus(renderer, {
        requestId: sentRequestId(renderer),
        focused: true
      })
    ).toBe(false)
  })

  it('resolves null when the embedder is destroyed mid-request', async () => {
    const renderer = mockWebContents(1)
    const focused = requestBrowserGuestKeyboardFocus(mockWebContents(2, renderer))

    renderer.emit('destroyed')

    await expect(focused).resolves.toBe('unanswered')
  })

  it('focuses a guest with no embedder natively', async () => {
    const guest = mockWebContents(2)

    await expect(requestBrowserGuestKeyboardFocus(guest)).resolves.toBe('unanswered')
    expect(guest.focus).toHaveBeenCalledTimes(1)
  })
})
