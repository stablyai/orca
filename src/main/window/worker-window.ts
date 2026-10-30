import { randomUUID } from 'node:crypto'
import { BrowserWindow, nativeTheme, type WebContents } from 'electron'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { Store } from '../persistence'
import type { DeviceEntry } from '../runtime/device-entry'
import { translateMain } from '../i18n/main-i18n'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'
import { showWindowWithoutStealingFocus } from './foreground-activation-policy'
import { stepUIZoomLevel, type UIZoomDirection } from '../../shared/ui-zoom-level'
import { QUIT_RENDERER_ACK_TIMEOUT_MS } from '../../shared/quit-teardown-deadline'
import {
  trackWorkerTerminalWindow,
  type WindowTerminalRuntime
} from './worker-window-terminal-visibility'

type WorkerWindowRuntime = Pick<
  OrcaRuntimeRpcServer,
  'createPairingOffer' | 'revokeRuntimeAccess'
> & {
  getDeviceRegistry: () => {
    listDevices: () => readonly Pick<DeviceEntry, 'deviceId' | 'forkedFrom'>[]
  } | null
}
type WorkerWindowStore = Pick<Store, 'getUI'>

const workerWindows = new Set<BrowserWindow>()
let retainedHostWindow: BrowserWindow | null = null

export function getWorkerWindows(): readonly BrowserWindow[] {
  return [...workerWindows].filter((window) => !window.isDestroyed())
}

export function forgetRetainedHostWindow(window: BrowserWindow): void {
  if (retainedHostWindow === window) {
    retainedHostWindow = null
  }
}

export async function closeWorkerWindowsForUserQuit(): Promise<boolean> {
  const results = await Promise.all(
    getWorkerWindows().map(
      (window) =>
        new Promise<boolean>((resolve) => {
          const contents = window.webContents
          const finish = (closed: boolean): void => {
            clearTimeout(timeout)
            window.removeListener('closed', onClosed)
            contents.removeListener('will-prevent-unload', onVeto)
            resolve(closed)
          }
          const onClosed = (): void => finish(true)
          const onVeto = (): void => finish(false)
          const timeout = setTimeout(() => finish(false), QUIT_RENDERER_ACK_TIMEOUT_MS)
          timeout.unref?.()
          window.once('closed', onClosed)
          contents.once('will-prevent-unload', onVeto)
          try {
            window.close()
          } catch {
            finish(false)
          }
        })
    )
  )
  return results.every(Boolean)
}

function revokeWorkerWindowAccess(runtime: WorkerWindowRuntime, deviceId: string): void {
  // Browser key upgrades fork a new identity; closing its window must revoke that grant too.
  const devices = runtime.getDeviceRegistry()?.listDevices() ?? []
  for (const device of devices) {
    if (device.forkedFrom === deviceId) {
      runtime.revokeRuntimeAccess(device.deviceId)
    }
  }
  runtime.revokeRuntimeAccess(deviceId)
}

export function isWorkerWindowRenderer(contents: WebContents): boolean {
  return [...workerWindows].some(
    (window) => !window.isDestroyed() && window.webContents === contents
  )
}

export function retainHostWindowForWorkers(window: BrowserWindow): boolean {
  if (workerWindows.size === 0) {
    return false
  }
  retainedHostWindow = window
  window.once('show', () => {
    if (retainedHostWindow === window) {
      retainedHostWindow = null
    }
  })
  window.hide()
  return true
}

function releaseRetainedHostWindow(): void {
  const host = retainedHostWindow
  if (workerWindows.size > 0 || !host || host.isDestroyed()) {
    return
  }
  retainedHostWindow = null
  // Let the normal host close flow present unsaved-file and running-session confirmation.
  showWindowWithoutStealingFocus(host)
  host.close()
}

export function zoomWorkerWindowIfFocused(direction: UIZoomDirection): boolean {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused || !workerWindows.has(focused)) {
    return false
  }
  focused.webContents.setZoomLevel(stepUIZoomLevel(focused.webContents.getZoomLevel(), direction))
  return true
}

/** Reuse paired-client isolation instead of publishing a second authoritative terminal graph. */
export async function createWorkerWindow(
  runtime: WorkerWindowRuntime,
  store: WorkerWindowStore,
  terminalRuntime?: WindowTerminalRuntime
): Promise<BrowserWindow> {
  const id = randomUUID()
  const offer = runtime.createPairingOffer({
    address: '127.0.0.1',
    name: `Orca window ${id}`,
    scope: 'runtime',
    reach: 'this-computer',
    dedicated: true
  })
  if (!offer.available) {
    throw new Error(
      translateMain('native.window.unavailable', 'Additional windows are unavailable.')
    )
  }
  if (!offer.webClientUrl) {
    revokeWorkerWindowAccess(runtime, offer.deviceId)
    throw new Error(
      translateMain('native.window.unavailable', 'Additional windows are unavailable.')
    )
  }

  let window: BrowserWindow | undefined
  try {
    window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 700,
      minHeight: 520,
      title: 'Orca',
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Separate client storage keeps project filters and tab selection independent.
        partition: `orca-worker-window-${id}`
      }
    })
    const worker = window
    if (terminalRuntime) {
      trackWorkerTerminalWindow(
        terminalRuntime,
        worker,
        offer.deviceId,
        () => runtime.getDeviceRegistry()?.listDevices() ?? []
      )
    }
    workerWindows.add(worker)
    installPrivilegedWindowNavigationPolicy(worker.webContents)
    worker.webContents.setZoomLevel(store.getUI().uiZoomLevel ?? 0)
    worker.once('closed', () => {
      workerWindows.delete(worker)
      revokeWorkerWindowAccess(runtime, offer.deviceId)
      releaseRetainedHostWindow()
    })
    worker.once('ready-to-show', () => showWindowWithoutStealingFocus(worker))
    const url = new URL(offer.webClientUrl)
    url.searchParams.set('orcaWindow', 'worker')
    await worker.loadURL(url.toString())
    return worker
  } catch {
    // Never include a credential-bearing pairing URL in a startup error or log.
    if (window && !window.isDestroyed()) {
      window.destroy()
    }
    revokeWorkerWindowAccess(runtime, offer.deviceId)
    throw new Error(
      translateMain('native.window.openFailed', 'Could not open another Orca window.')
    )
  }
}
