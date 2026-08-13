import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'
import {
  UPDATER_INSTALL_COMMITTED_CHANNEL,
  UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL
} from '../shared/updater-install-events'

// Drives the SHIPPING preload, not the extracted helper: the helper being correct
// proves nothing if production never calls it, or calls it too late.
const { exposeInMainWorld, invoke, on, removeListener, send, sendSync, callOrder } = vi.hoisted(
  () => {
    const order: string[] = []
    return {
      callOrder: order,
      exposeInMainWorld: vi.fn(),
      invoke: vi.fn(),
      on: vi.fn((channel: string, _listener: (event: unknown, committed: boolean) => void) => {
        order.push(`on:${channel}`)
      }),
      removeListener: vi.fn(),
      send: vi.fn(),
      sendSync: vi.fn((channel: string) => {
        order.push(`sendSync:${channel}`)
        return false
      })
    }
  }
)

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener, send, sendSync },
  webFrame: {
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

describe('shipping preload updater install commitment wiring', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')

  beforeEach(() => {
    vi.resetModules()
    callOrder.length = 0
    exposeInMainWorld.mockClear()
    on.mockClear()
    sendSync.mockClear()
    sendSync.mockImplementation((channel: string) => {
      callOrder.push(`sendSync:${channel}`)
      return false
    })
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', { addEventListener: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalContextIsolated) {
      Object.defineProperty(process, 'contextIsolated', originalContextIsolated)
    } else {
      Reflect.deleteProperty(process, 'contextIsolated')
    }
  })

  it('subscribes and samples eagerly at module scope, in that order', async () => {
    await import('./index')

    // Eager: a document must be protected before its first script runs, not on the
    // first read. Ordered: subscribing after sampling would drop a broadcast that
    // lands in between, and it could never be recovered while main is blocked in
    // the Linux installer.
    const subscribe = callOrder.indexOf(`on:${UPDATER_INSTALL_COMMITTED_CHANNEL}`)
    const sample = callOrder.indexOf(`sendSync:${UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL}`)

    expect(subscribe).toBeGreaterThanOrEqual(0)
    expect(sample).toBeGreaterThanOrEqual(0)
    expect(subscribe).toBeLessThan(sample)
  })

  it('exposes main’s answer rather than a hardcoded false', async () => {
    sendSync.mockImplementation((channel: string) => {
      callOrder.push(`sendSync:${channel}`)
      return channel === UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL
    })

    await import('./index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi

    expect(api.updater.isInstallCommittedNow()).toBe(true)
  })

  it('exposes a live reader, so a later broadcast is visible', async () => {
    await import('./index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi
    expect(api.updater.isInstallCommittedNow()).toBe(false)

    const subscription = on.mock.calls.find(
      ([channel]) => channel === UPDATER_INSTALL_COMMITTED_CHANNEL
    )
    expect(subscription).toBeDefined()
    subscription?.[1]?.(null, true)

    expect(api.updater.isInstallCommittedNow()).toBe(true)
  })
})
