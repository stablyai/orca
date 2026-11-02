import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

/** Inject desktop surfaces so the same PTY controller can also serve Node-only hosts. */

/** Match Electron's any[] listener arguments so the real IPC surface remains assignable without casts. */
export type PtyIpcSurface = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void
  removeHandler(channel: string): void
  removeAllListeners(channel: string): void
}

export type PtyPowerSurface = {
  on(event: 'suspend' | 'resume', listener: () => void): void
}

export const noopPtyIpcSurface: PtyIpcSurface = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
  removeAllListeners: () => {}
}

export const noopPtyPowerSurface: PtyPowerSurface = {
  on: () => {}
}

let currentIpc: PtyIpcSurface = noopPtyIpcSurface
let currentPower: PtyPowerSurface = noopPtyPowerSurface

/** Headless hosts have no renderer; omitted IPC/power surfaces intentionally use no-op registration. */
export function setPtyHostBindings(bindings: {
  ipc?: PtyIpcSurface
  power?: PtyPowerSurface
}): void {
  currentIpc = bindings.ipc ?? noopPtyIpcSurface
  currentPower = bindings.power ?? noopPtyPowerSurface
}

export function getPtyIpc(): PtyIpcSurface {
  return currentIpc
}

export function getPtyPower(): PtyPowerSurface {
  return currentPower
}
