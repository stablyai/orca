import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import type { DeviceEntry } from '../runtime/device-entry'

export type WindowTerminalRuntime = {
  setLocalTerminalWindowVisible: (windowId: number, visible: boolean) => void
  removeLocalTerminalWindow: (windowId: number) => void
  setLocalTerminalWindowLease: (
    ptyId: string,
    leaseKey: string,
    windowId: number,
    visible: boolean
  ) => void
  removeLocalTerminalWindowLease: (ptyId: string, leaseKey: string) => void
}

type WorkerRegistration = {
  window: BrowserWindow
  generation: number
  rootDeviceId: string
  devices: () => readonly Pick<DeviceEntry, 'deviceId' | 'forkedFrom'>[]
}

export type WorkerTerminalWindow = { windowId: number; generation: number }
const workers = new WeakMap<WindowTerminalRuntime, Map<number, WorkerRegistration>>()
const trackedWindows = new WeakMap<WindowTerminalRuntime, WeakSet<BrowserWindow>>()
const windowsByContents = new WeakMap<
  WindowTerminalRuntime,
  WeakMap<object, { window: BrowserWindow; documentReady: boolean }>
>()

function nativeVisible(window: BrowserWindow): boolean {
  return !window.isDestroyed() && window.isVisible() && !window.isMinimized()
}

export function trackTerminalWindow(runtime: WindowTerminalRuntime, window: BrowserWindow): void {
  let tracked = trackedWindows.get(runtime)
  if (!tracked) {
    tracked = new WeakSet()
    trackedWindows.set(runtime, tracked)
  }
  if (tracked.has(window)) {
    return
  }
  tracked.add(window)
  let contents = windowsByContents.get(runtime)
  if (!contents) {
    contents = new WeakMap()
    windowsByContents.set(runtime, contents)
  }
  const document = { window, documentReady: true }
  contents.set(window.webContents, document)
  const update = (): void => runtime.setLocalTerminalWindowVisible(window.id, nativeVisible(window))
  update()
  window.on('show', update)
  window.on('hide', update)
  window.on('minimize', update)
  window.on('restore', update)
  const clear = (): void => {
    document.documentReady = false
    runtime.removeLocalTerminalWindow(window.id)
    update()
  }
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      clear()
    }
  })
  window.webContents.on('render-process-gone', clear)
  window.webContents.on('dom-ready', () => {
    document.documentReady = true
  })
  window.once('closed', () => runtime.removeLocalTerminalWindow(window.id))
}

export function reportHostTerminalWindowLease(
  runtime: WindowTerminalRuntime | undefined,
  sender: WebContents,
  ptyId: string,
  visible: boolean,
  senderFrame: WebFrameMain | null
): void {
  if (!runtime) {
    return
  }
  const document = windowsByContents.get(runtime)?.get(sender)
  const window = document?.window
  if (
    !window ||
    window.isDestroyed() ||
    !document.documentReady ||
    !senderFrame ||
    senderFrame !== window.webContents.mainFrame
  ) {
    return
  }
  runtime.setLocalTerminalWindowVisible(window.id, nativeVisible(window))
  runtime.setLocalTerminalWindowLease(ptyId, `host:${window.id}`, window.id, visible)
}

export function trackWorkerTerminalWindow(
  runtime: WindowTerminalRuntime,
  window: BrowserWindow,
  rootDeviceId: string,
  devices: WorkerRegistration['devices']
): void {
  let windows = workers.get(runtime)
  if (!windows) {
    windows = new Map()
    workers.set(runtime, windows)
  }
  const registration = { window, rootDeviceId, devices, generation: 0 }
  windows.set(window.id, registration)
  trackTerminalWindow(runtime, window)
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      registration.generation++
    }
  })
  window.webContents.on('render-process-gone', () => registration.generation++)
  window.once('closed', () => windows.delete(window.id))
}

export function resolveWorkerTerminalWindow(
  runtime: WindowTerminalRuntime,
  pairedDeviceId: string | undefined
): WorkerTerminalWindow | undefined {
  if (!pairedDeviceId) {
    return undefined
  }
  for (const [windowId, entry] of workers.get(runtime) ?? []) {
    if (entry.window.isDestroyed()) {
      continue
    }
    const devices = new Map(entry.devices().map((device) => [device.deviceId, device]))
    let device = devices.get(pairedDeviceId)
    const visited = new Set<string>()
    while (device && !visited.has(device.deviceId)) {
      if (device.deviceId === entry.rootDeviceId) {
        return { windowId, generation: entry.generation }
      }
      visited.add(device.deviceId)
      device = device.forkedFrom ? devices.get(device.forkedFrom) : undefined
    }
  }
  return undefined
}

export function reportWorkerTerminalWindowLease(
  runtime: WindowTerminalRuntime,
  binding: WorkerTerminalWindow | undefined,
  ptyId: string,
  leaseKey: string,
  visible: boolean
): void {
  if (!binding) {
    return
  }
  const current = workers.get(runtime)?.get(binding.windowId)
  if (!current || current.generation !== binding.generation || current.window.isDestroyed()) {
    return
  }
  runtime.setLocalTerminalWindowVisible(binding.windowId, nativeVisible(current.window))
  runtime.setLocalTerminalWindowLease(ptyId, leaseKey, binding.windowId, visible)
}
