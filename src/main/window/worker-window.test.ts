import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../shared/constants'
import { QUIT_RENDERER_ACK_TIMEOUT_MS } from '../../shared/quit-teardown-deadline'
import { parsePairingCode } from '../../shared/pairing'
import { DeviceRegistry } from '../runtime/device-registry'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

const fixture = vi.hoisted(() => {
  const options: Electron.BrowserWindowConstructorOptions[] = []
  return { options, failLoad: false, present: vi.fn() }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class BrowserWindow extends EventEmitter {
    static getFocusedWindow = () => null
    private destroyed = false
    readonly webContents = Object.assign(new EventEmitter(), {
      setZoomLevel: vi.fn(),
      getZoomLevel: () => 0
    })
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
  closeWorkerWindowsForUserQuit,
  forgetRetainedHostWindow,
  getWorkerWindows,
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
const userDataPaths: string[] = []

afterEach(() => {
  for (const window of getWorkerWindows()) {
    window.destroy()
  }
  for (const userDataPath of userDataPaths.splice(0)) {
    rmSync(userDataPath, { recursive: true, force: true })
  }
})

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
        scope: 'runtime',
        dedicated: true
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

  it('keeps unused offers and simultaneous worker credential families independent', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-worker-window-pairing-'))
    userDataPaths.push(userDataPath)
    const registry = new DeviceRegistry(userDataPath)
    const runtime = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      webClientRoot: userDataPath
    })
    runtime['deviceRegistry'] = registry
    vi.spyOn(runtime, 'getWebSocketEndpoint').mockReturnValue('ws://127.0.0.1:6768')
    vi.spyOn(runtime, 'getE2EEPublicKey').mockReturnValue(Buffer.alloc(32, 1).toString('base64'))
    const pending = runtime.createPairingOffer({ name: 'Unused user offer' })
    if (!pending.available) {
      throw new Error('Pairing offer unavailable')
    }
    const pendingDevice = registry.getDevice(pending.deviceId)
    expect(pendingDevice?.lastSeenAt).toBe(0)
    const [first, second] = await Promise.all([
      createWorkerWindow(runtime, store),
      createWorkerWindow(runtime, store)
    ])
    const deviceForWindow = (window: BrowserWindow) => {
      const address = vi.mocked(window.loadURL).mock.calls[0][0]
      const encodedPairing = new URL(address).hash.slice('#pairing='.length)
      const offer = parsePairingCode(decodeURIComponent(encodedPairing))
      const device = registry.getDevice(offer?.pairedDeviceId ?? '')
      if (!device?.token) {
        throw new Error('Worker credential unavailable')
      }
      return { ...device, token: device.token }
    }
    const firstDevice = deviceForWindow(first)
    const secondDevice = deviceForWindow(second)
    expect(new Set([pending.deviceId, firstDevice.deviceId, secondDevice.deviceId]).size).toBe(3)
    expect(firstDevice).toMatchObject({ pairingReach: 'this-computer', dedicatedPairing: true })
    expect(secondDevice).toMatchObject({ pairingReach: 'this-computer', dedicatedPairing: true })
    const firstKey = registry.forkDeviceKey(
      firstDevice.deviceId,
      Buffer.alloc(32, 2).toString('base64'),
      'First worker',
      { ephemeral: true }
    )
    const secondKey = registry.forkDeviceKey(
      secondDevice.deviceId,
      Buffer.alloc(32, 3).toString('base64'),
      'Second worker',
      { ephemeral: true }
    )
    expect(runtime.createPairingOffer({ name: 'User reopens pairing' })).toMatchObject({
      available: true,
      deviceId: pending.deviceId
    })
    expect(getWorkerWindows()).toEqual([first, second])

    first.close()
    expect(registry.validateToken(firstDevice.token)).toBeNull()
    expect(registry.lookupDeviceKey(firstKey.deviceId)).toEqual({ kind: 'unknown' })
    expect(registry.getDevice(pending.deviceId)).toEqual(pendingDevice)
    expect(registry.validateToken(secondDevice.token)?.deviceId).toBe(secondDevice.deviceId)
    expect(registry.lookupDeviceKey(secondKey.deviceId)).toMatchObject({ kind: 'found' })
    expect(getWorkerWindows()).toEqual([second])

    second.close()
    expect(registry.validateToken(secondDevice.token)).toBeNull()
    expect(registry.lookupDeviceKey(secondKey.deviceId)).toEqual({ kind: 'unknown' })
    expect(registry.validateToken(pendingDevice?.token ?? '')?.deviceId).toBe(pending.deviceId)
    expect(getWorkerWindows()).toEqual([])
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

  it('does not close a retained host again after an explicit quit releases it', async () => {
    const worker = await createWorkerWindow(makeRuntime(), store)
    const host = new BrowserWindow({ show: false })
    expect(retainHostWindowForWorkers(host)).toBe(true)
    forgetRetainedHostWindow(host)
    worker.close()
    expect(host.close).not.toHaveBeenCalled()
    expect(fixture.present).not.toHaveBeenCalledWith(host)
    host.destroy()
  })

  it('honors a worker unload veto before reporting user Quit complete', async () => {
    const worker = await createWorkerWindow(makeRuntime(), store)
    vi.mocked(worker.close).mockImplementationOnce(() => {
      worker.webContents.emit('will-prevent-unload', {})
    })

    expect(await closeWorkerWindowsForUserQuit()).toBe(false)
    expect(worker.isDestroyed()).toBe(false)
    expect(getWorkerWindows()).toEqual([worker])
    expect(await closeWorkerWindowsForUserQuit()).toBe(true)
    expect(getWorkerWindows()).toEqual([])
  })

  it('bounds a frozen worker close so user Quit can be retried', async () => {
    vi.useFakeTimers()
    try {
      const worker = await createWorkerWindow(makeRuntime(), store)
      vi.mocked(worker.close).mockImplementationOnce(() => {})
      const pending = closeWorkerWindowsForUserQuit()
      await vi.advanceTimersByTimeAsync(QUIT_RENDERER_ACK_TIMEOUT_MS)
      expect(await pending).toBe(false)
      expect(worker.isDestroyed()).toBe(false)
      expect(await closeWorkerWindowsForUserQuit()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
