import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { cursor } = vi.hoisted(() => ({ cursor: { x: 10, y: 20 } }))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ ...cursor }) }
}))

import { setupGuestTargetUrlForwarding } from './browser-guest-target-url'

let guest: EventEmitter
let send: ReturnType<typeof vi.fn>
let teardown: () => void

beforeEach(() => {
  vi.useFakeTimers()
  guest = new EventEmitter()
  send = vi.fn()
  teardown = setupGuestTargetUrlForwarding({
    browserTabId: 'page-1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forwarder only uses on/off, which EventEmitter implements with Electron's semantics.
    guest: guest as unknown as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forwarder only calls send on the renderer.
    resolveRenderer: () => ({ send }) as unknown as Electron.WebContents
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const sentUrls = (): string[] => send.mock.calls.map(([, event]) => event.url)

it('tracks the pointer only while a link is targeted, at most once per interval', () => {
  expect(guest.listenerCount('before-mouse-event')).toBe(0)

  guest.emit('update-target-url', {}, 'https://example.com/a')
  expect(send).toHaveBeenLastCalledWith('browser:target-url-changed', {
    browserPageId: 'page-1',
    url: 'https://example.com/a',
    screenX: 10,
    screenY: 20
  })

  cursor.x = 30
  guest.emit('before-mouse-event', {}, { type: 'mouseMove' })
  guest.emit('before-mouse-event', {}, { type: 'mouseMove' })
  vi.advanceTimersByTime(100)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1][1]).toMatchObject({ url: 'https://example.com/a', screenX: 30 })

  guest.emit('update-target-url', {}, '')
  expect(guest.listenerCount('before-mouse-event')).toBe(0)
  guest.emit('before-mouse-event', {}, { type: 'mouseMove' })
  vi.advanceTimersByTime(100)
  expect(sentUrls()).toEqual(['https://example.com/a', 'https://example.com/a', ''])
})

it('clears the target when the guest dies or is unregistered under a hovered link', () => {
  guest.emit('update-target-url', {}, 'https://example.com/a')
  guest.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(sentUrls()).toEqual(['https://example.com/a', ''])

  guest.emit('update-target-url', {}, 'https://example.com/b')
  teardown()
  expect(sentUrls()).toEqual(['https://example.com/a', '', 'https://example.com/b', ''])
  expect(guest.listenerCount('before-mouse-event')).toBe(0)
})
