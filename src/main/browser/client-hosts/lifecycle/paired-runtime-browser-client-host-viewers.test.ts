import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeDesktopSurface } from '../../../runtime/construction/runtime-desktop-surface'
import {
  pairedRuntimeBrowserClientHostViewer,
  recordClientHostViewer
} from './paired-runtime-browser-client-host-viewers'

afterEach(() => setRuntimeDesktopSurface(null))

describe('client host viewers', () => {
  it('publishes record and release, and a replaced host’s release leaves its successor', () => {
    const sendToRenderers = vi.fn()
    setRuntimeDesktopSurface({
      showNotification: () => false,
      hasWindow: () => false,
      hasLiveRenderer: () => false,
      sendToWindow: () => false,
      requestRenderer: () => Promise.reject(new Error('none')),
      sendToRenderers
    })
    const releaseFirst = recordClientHostViewer('env', 'own-computer')
    const releaseSecond = recordClientHostViewer('env', 'teammate')
    releaseFirst()
    expect(pairedRuntimeBrowserClientHostViewer('env')).toBe('teammate')
    releaseSecond()
    expect(pairedRuntimeBrowserClientHostViewer('env')).toBeNull()
    expect(sendToRenderers.mock.calls.map(([, event]) => event)).toEqual([
      { environmentId: 'env', viewer: 'own-computer' },
      { environmentId: 'env', viewer: 'teammate' },
      { environmentId: 'env', viewer: null }
    ])
  })
})
