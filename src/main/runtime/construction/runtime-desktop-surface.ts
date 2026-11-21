/** Optional desktop facilities for runtime hosts, addressed by window id with plain data so a host outside Electron main can supply them.
 * Node hosts legitimately lack these; terminal creation uses background spawn without a window (#10333), and notifications route to paired clients. */

/** A renderer request answered on `replyChannel`; the host adds the `requestId` the reply must echo. */
export type RendererRequest = {
  channel: string
  replyChannel: string
  payload: object
  timeoutMs: number
  timeoutMessage: string
  signal?: AbortSignal
  abortMessage?: string
}

export type RendererReply = { requestId: string }

export type RuntimeDesktopSurface = {
  /** Headless hosts retain the formatter's English defaults. */
  translateNotification?(key: string, fallback: string): string
  /** This machine's own idle state; undefined is unknown. Absent on hosts with no desktop. */
  isAwayForMobileNotifications?(): boolean | undefined
  /** Show a native notification. Returns false when the host cannot, so callers can say so. */
  showNotification(input: { title: string; body: string }): boolean
  /** Sends to every open renderer window. Absent where there is no desktop. */
  sendToRenderers?(channel: string, payload: unknown): void
  /** Whether this window is open; its renderer may already be gone during teardown. */
  hasWindow(windowId: number): boolean
  /** Whether this window is open and its renderer is alive. */
  hasLiveRenderer(windowId: number): boolean
  /** False when the window or its renderer is gone. */
  sendToWindow(windowId: number, channel: string, payload: unknown): boolean
  /** Only a reply from the window's own renderer settles it; rejects on timeout, abort, or when the window or renderer goes away. */
  requestRenderer<T extends RendererReply>(windowId: number, request: RendererRequest): Promise<T>
  /** Keeps the window's renderer publishing while hidden until the returned release runs. */
  holdRendererPublication?(windowId: number): () => void
  /** The window's renderer id, which browser page retention records as a page's creator. */
  rendererIdOfWindow?(windowId: number): number | null
  /** Whether the window holding this renderer is shown; absent on Node hosts, which have no resource view. */
  isResourceViewVisible?(rendererId: number): boolean
  /** Re-encodes as a PNG fitting `maxEdge`; null if undecodable. Absent on Node hosts. */
  encodeRepoIconPng?(bytes: Uint8Array, maxEdge: number): Uint8Array | null
  /** A GET answering redirects with the 3xx, without proxy login; absent where fetch already does. */
  fetchRepoIcon?(url: string, init: RequestInit): Promise<Response>
}

const inertDesktopSurface: RuntimeDesktopSurface = {
  showNotification: () => false,
  hasWindow: () => false,
  hasLiveRenderer: () => false,
  sendToWindow: () => false,
  requestRenderer: () => Promise.reject(new Error('No renderer window available'))
}

let current: RuntimeDesktopSurface = inertDesktopSurface

export function setRuntimeDesktopSurface(surface: RuntimeDesktopSurface | null): void {
  current = surface ?? inertDesktopSurface
}

export function getRuntimeDesktopSurface(): RuntimeDesktopSurface {
  return current
}
