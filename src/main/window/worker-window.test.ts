import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../shared/constants'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

const fixture = vi.hoisted(() => {
  const options: Electron.BrowserWindowConstructorOptions[] = []
  return { options, failLoad: false, present: vi.fn() }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class BrowserWindow extends EventEmitter {
    static getFocusedWindow = () => null
    private destroyed = false
    readonly webContents = {
      setZoomLevel: vi.fn(),
      getZoomLevel: () => 0
    }
    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super()
      fixture.options.push(options)
    }
    isDestroyed() {
      return this.destroyed
    }
    hide = vi.fn()
    close = vi.fn(() => this.destroy())
    destroy() {
      if (this.destroyed) {
        return
      }
      this.destroyed = true
      this.emit('closed')
    }
    loadURL = vi.fn(async () => {
      if (fixture.failLoad) {
        throw new Error('http://localhost/#pairing=secret')
      }
    })
  }
  return { BrowserWindow, nativeTheme: { shouldUseDarkColors: true } }
})
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))
vi.mock('./foreground-activation-policy', () => ({
  showWindowWithoutStealingFocus: fixture.present
}))

import { BrowserWindow } from 'electron'
import {
  createWorkerWindow,
  isWorkerWindowRenderer,
  retainHostWindowForWorkers
} from './worker-window'

function makeRuntime() {
  let issued = 0
  const devices: { deviceId: string; forkedFrom?: string }[] = []
  return {
    devices,
    getDeviceRegistry: () => ({ listDevices: () => devices }),
    createPairingOffer: vi.fn(
      (
        _args: Parameters<OrcaRuntimeRpcServer['createPairingOffer']>[0]
      ): ReturnType<OrcaRuntimeRpcServer['createPairingOffer']> => ({
        available: true,
        deviceId: `device-${++issued}`,
        pairingUrl: 'orca://pair?secret',
        endpoint: 'ws://127.0.0.1:6768',
        webClientUrl: 'http://127.0.0.1:6768/web-index.html#pairing=secret'
      })
    ),
    revokeRuntimeAccess: vi.fn(() => true)
  }
}
const store = { getUI: getDefaultUIState }

beforeEach(() => {
  fixture.options.length = 0
  fixture.failLoad = false
  fixture.present.mockClear()
})

describe('additional profile windows', () => {
  it('isolates client storage and revokes only the closing window grant', async () => {
    const runtime = makeRuntime()
    const first = await createWorkerWindow(runtime, store)
    const second = await createWorkerWindow(runtime, store)
    expect(runtime.createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '127.0.0.1',
        reach: 'this-computer',
        scope: 'runtime'
      })
    )
    expect(fixture.options[0].webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
    expect(fixture.options[0].webPreferences?.preload).toBeUndefined()
    expect(fixture.options[0].webPreferences?.partition).not.toBe(
      fixture.options[1].webPreferences?.partition
    )
    expect(first.loadURL).toHaveBeenCalledWith(expect.stringContaining('?orcaWindow=worker'))
    runtime.devices.push({ deviceId: 'first-window-key', forkedFrom: 'device-1' })
    first.close()
    expect(runtime.revokeRuntimeAccess).toHaveBeenCalledWith('first-window-key')
    expect(runtime.revokeRuntimeAccess).toHaveBeenCalledWith('device-1')
    expect(isWorkerWindowRenderer(second.webContents)).toBe(true)
    expect(runtime.revokeRuntimeAccess).not.toHaveBeenCalledWith('device-2')
    second.close()
  })

  it('keeps the host renderer alive until the last worker closes', async () => {
    const runtime = makeRuntime()
    const first = await createWorkerWindow(runtime, store)
    const second = await createWorkerWindow(runtime, store)
    const host = new BrowserWindow({ show: false })
    expect(retainHostWindowForWorkers(host)).toBe(true)
    expect(host.hide).toHaveBeenCalled()
    first.close()
    expect(host.close).not.toHaveBeenCalled()
    second.close()
    expect(fixture.present).toHaveBeenCalledWith(host)
    expect(host.close).toHaveBeenCalledOnce()
  })

  it('cleans up a failed launch without exposing the pairing credential', async () => {
    const runtime = makeRuntime()
    fixture.failLoad = true
    await expect(createWorkerWindow(runtime, store)).rejects.toThrow(
      'Could not open another Orca window.'
    )
    expect(runtime.revokeRuntimeAccess).toHaveBeenCalledWith('device-1')
  })

  it('revokes offers when the web client is missing', async () => {
    const runtime = makeRuntime()
    runtime.createPairingOffer.mockReturnValue({
      available: true,
      deviceId: 'no-client',
      endpoint: 'ws://127.0.0.1:6768',
      pairingUrl: 'orca://pair?secret',
      webClientUrl: null
    })
    await expect(createWorkerWindow(runtime, store)).rejects.toThrow(
      'Additional windows are unavailable.'
    )
    expect(runtime.revokeRuntimeAccess).toHaveBeenCalledWith('no-client')
  })
})
