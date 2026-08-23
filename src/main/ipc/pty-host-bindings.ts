import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

/**
 * The host facilities the PTY handlers register against.
 *
 * Why injected rather than imported: `registerPtyHandlers` owns the PTY controller
 * that `terminal.create` actually spawns through, and a Node-only backend needs that
 * controller. Everything else in the module is already host-agnostic — the only thing
 * pinning it to Electron was a static `ipcMain` / `powerMonitor` import used purely to
 * register renderer handlers that no headless host will ever receive.
 *
 * The desktop passes the real Electron objects. A headless host passes nothing and
 * gets no-ops, which is honest: there is no renderer to answer, so registering is a
 * no-op rather than a lie about having registered.
 */

/**
 * Deliberately `any[]` on the rest args, matching Electron's own `IpcMain` signature:
 * a narrower type here would not accept the real object, and widening at the call site
 * would need a cast that hides genuine mismatches.
 */
export type PtyIpcSurface = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void
  removeHandler(channel: string): void
  removeAllListeners(channel: string): void
}

export type PtyPowerSurface = {
  on(event: 'suspend' | 'resume', listener: () => void): void
}

/** Why not optional-chaining at 75 call sites: one object keeps the call sites unchanged. */
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

/**
 * Install the host surfaces once at startup. Defaults are no-ops rather than a throw,
 * unlike AppEnvironment/SecretStore: a host with no renderer legitimately has nothing to
 * register against, and silently not registering handlers nobody can call is correct
 * rather than a hidden downgrade.
 */
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
