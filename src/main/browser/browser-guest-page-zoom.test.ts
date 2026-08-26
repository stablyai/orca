import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { attachRemoteBrowserGuestPageZoomReassert } from './browser-guest-page-zoom'

describe('attachRemoteBrowserGuestPageZoomReassert', () => {
  it('resets inherited origin zoom immediately and after later loads', () => {
    const guest = new EventEmitter() as EventEmitter & {
      zoomLevel: number
      isDestroyed: () => boolean
      getZoomLevel: () => number
      setZoomLevel: (level: number) => void
    }
    guest.zoomLevel = 3
    guest.isDestroyed = () => false
    guest.getZoomLevel = () => guest.zoomLevel
    guest.setZoomLevel = vi.fn((level: number) => {
      guest.zoomLevel = level
    })

    const detach = attachRemoteBrowserGuestPageZoomReassert(guest as never)
    expect(guest.setZoomLevel).toHaveBeenCalledWith(0)
    expect(guest.zoomLevel).toBe(0)

    guest.zoomLevel = 2
    guest.emit('dom-ready')
    expect(guest.zoomLevel).toBe(0)

    guest.zoomLevel = 4
    guest.emit('did-finish-load')
    expect(guest.zoomLevel).toBe(0)

    detach()
    guest.zoomLevel = 3
    guest.emit('dom-ready')
    expect(guest.zoomLevel).toBe(3)
  })
})
