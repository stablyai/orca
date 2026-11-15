import type { BrowserWindow, IpcMainEvent, WebContents } from 'electron'

/** Optional Electron facilities for runtime hosts: notifications, renderer lookup and renderer-backed tab creation IPC.
 * Node hosts legitimately lack these; terminal creation uses background spawn without a window (#10333), and notifications route to paired clients. */

export type RuntimeDesktopSurface = {
  /** UI-language text for runtime code; headless hosts keep the English defaults. */
  translate?(key: string, fallback: string): string
  /** This machine's own idle state; undefined is unknown. Absent on hosts with no desktop. */
  isAwayForMobileNotifications?(): boolean | undefined
  /** Show a native notification. Returns false when the host cannot, so callers can say so. */
  showNotification(input: { title: string; body: string }): boolean
  /** Sends to every open renderer window. Absent where there is no desktop. */
  sendToRenderers?(channel: string, payload: unknown): void
  /** The renderer window with this id, or null when there is no desktop. */
  findWindowById(id: number): BrowserWindow | null
  isResourceViewVisible?(sender: WebContents): boolean
  onIpc(channel: string, listener: (event: IpcMainEvent, ...args: never[]) => void): void
  removeIpcListener(channel: string, listener: (...args: never[]) => void): void
  /** Re-encodes as a PNG fitting `maxEdge`; null if undecodable. Absent on Node hosts. */
  encodeRepoIconPng?(bytes: Uint8Array, maxEdge: number): Uint8Array | null
  /** A GET answering redirects with the 3xx, without proxy login; absent where fetch already does. */
  fetchRepoIcon?(url: string, init: RequestInit): Promise<Response>
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
