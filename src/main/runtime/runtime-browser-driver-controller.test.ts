import { describe, expect, it, vi } from 'vitest'
import { RuntimeBrowserDriverController } from './runtime-browser-driver-controller'

describe('RuntimeBrowserDriverController', () => {
  it('removes desktop ownership after reclaiming a browser page', () => {
    const controller = new RuntimeBrowserDriverController({
      notifyChanged: vi.fn(),
      cancelScreencast: vi.fn()
    })

    controller.reclaimForDesktop('page-1')

    expect(controller.getAll()).toEqual(new Map())
  })

  it('releases mobile ownership while notifying desktop takeover and cancelling the stream', () => {
    const notifyChanged = vi.fn()
    const cancelScreencast = vi.fn()
    const controller = new RuntimeBrowserDriverController({ notifyChanged, cancelScreencast })
    controller.set('page-1', { kind: 'mobile', clientId: 'phone-1' })
    expect(controller.get('page-1')).toEqual({ kind: 'mobile', clientId: 'phone-1' })

    controller.reclaimForDesktop('page-1')

    expect(controller.getAll()).toEqual(new Map())
    expect(notifyChanged).toHaveBeenLastCalledWith('page-1', { kind: 'desktop' })
    expect(cancelScreencast).toHaveBeenCalledWith('page-1')
  })
})
