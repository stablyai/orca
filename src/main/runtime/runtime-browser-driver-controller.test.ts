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
})
