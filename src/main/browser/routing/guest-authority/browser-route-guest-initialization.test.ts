import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { initializeBrowserRouteGuest } from './browser-route-guest-initialization'

it.each(['commit', 'error-document'])(
  'redacts private initialization %s while navigating the selected guest with its bearer',
  async (kind) => {
    const raw = 'https://kagi.com/result?token=test-only&q=one'
    const guest = Object.assign(new EventEmitter(), {
      loadURL: vi.fn(() => new Promise<void>(() => {})),
      stop: vi.fn()
    })
    const initialized = initializeBrowserRouteGuest(
      guest,
      raw,
      new AbortController().signal,
      () => true
    )
    if (kind === 'commit') {
      guest.emit('did-navigate', {}, raw)
    } else {
      guest.emit('did-fail-provisional-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', raw, true)
    }
    await expect(initialized).resolves.toBe('https://kagi.com/result?q=one')
    expect(guest.loadURL).toHaveBeenCalledWith(raw)
  }
)
