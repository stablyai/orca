import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ screen: { getCursorScreenPoint: () => ({ x: 10, y: 20 }) } }))
import { setupGuestTargetUrlForwarding } from './browser-guest-target-url'

it.each([
  ['https://kagi.com/search?token=hover-secret&q=one', 'https://kagi.com/search?q=one'],
  ['https://example.com/?token=ordinary', 'https://example.com/?token=ordinary']
])('forwards safe hover metadata without changing the guest link: %s', (raw, safe) => {
  const guest = new EventEmitter()
  const send = vi.fn()
  const cleanup = setupGuestTargetUrlForwarding({
    browserTabId: 'page',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this boundary only registers native guest events.
    guest: guest as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding uses only the renderer send API.
    resolveRenderer: () => ({ send }) as unknown as Electron.WebContents
  })
  try {
    guest.emit('update-target-url', {}, raw)
    expect(send).toHaveBeenCalledWith('browser:target-url-changed', {
      browserPageId: 'page',
      url: safe,
      screenX: 10,
      screenY: 20
    })
  } finally {
    cleanup()
  }
})
