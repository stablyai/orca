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

/** A PTY's headless model, as far as the desktop's native terminal views read it. */
export type NativeTerminalFeedModel = {
  emulator: {
    getSnapshot: () => {
      snapshotAnsi: string
      scrollbackAnsi?: string
      rehydrateSequences: string
      pendingEscapeTailAnsi?: string
    }
  }
}

export type RuntimeDesktopSurface = {
  /** Headless hosts retain the formatter's English defaults. */
  translateNotification?(key: string, fallback: string): string
  /** Show a native notification. Returns false when the host cannot, so callers can say so. */
  isAwayForMobileNotifications?(): boolean | undefined
  showNotification(input: { title: string; body: string }): boolean
  /** The renderer window with this id, or null when there is no desktop. */
  findWindowById(id: number): BrowserWindow | null
  onIpc(channel: string, listener: (event: IpcMainEvent, ...args: never[]) => void): void
  removeIpcListener(channel: string, listener: (...args: never[]) => void): void
  /** On the PTY's write chain after `model` parsed `data`: native views bound to it take it. */
  feedNativeTerminalPty?(ptyId: string, model: NativeTerminalFeedModel, data: string): void
  /** On the write chain after main changed the model outside the byte stream (clear). */
  reseedNativeTerminalPty?(ptyId: string, model: NativeTerminalFeedModel): void
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
