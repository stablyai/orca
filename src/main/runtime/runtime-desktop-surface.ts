import type { BrowserWindow, IpcMainEvent } from 'electron'

/**
 * The desktop facilities `OrcaRuntimeService` uses, which a Node host does not have.
 *
 * Three sites, all optional by nature: a native notification toast, a lookup of the
 * authoritative renderer window, and one ipcMain channel used only by the
 * renderer-backed tab-create fallback. With no renderer that fallback is unreachable —
 * `createTerminal` already takes the background spawn branch when there is no
 * authoritative window (#10333) — so a Node host needs none of them.
 *
 * Defaults are inert rather than throwing, for the same reason as the PTY bindings: a
 * host with no desktop legitimately has nothing here, and that is not a downgrade.
 * Where absence IS user-visible — a notification that would have been shown — the
 * runtime already routes to paired clients, which is the better destination anyway.
 */

export type RuntimeDesktopSurface = {
  /** Show a native notification. Returns false when the host cannot, so callers can say so. */
  showNotification(input: { title: string; body: string }): boolean
  /** The renderer window with this id, or null when there is no desktop. */
  findWindowById(id: number): BrowserWindow | null
  onIpc(channel: string, listener: (event: IpcMainEvent, ...args: never[]) => void): void
  removeIpcListener(channel: string, listener: (...args: never[]) => void): void
}

const inertDesktopSurface: RuntimeDesktopSurface = {
  showNotification: () => false,
  findWindowById: () => null,
  onIpc: () => {},
  removeIpcListener: () => {}
}

let current: RuntimeDesktopSurface = inertDesktopSurface

export function setRuntimeDesktopSurface(surface: RuntimeDesktopSurface | null): void {
  current = surface ?? inertDesktopSurface
}

export function getRuntimeDesktopSurface(): RuntimeDesktopSurface {
  return current
}
