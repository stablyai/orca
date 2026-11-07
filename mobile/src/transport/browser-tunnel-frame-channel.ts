import type { RpcClient } from './rpc-client'

/** Browser tunnel frames to and from the host a client is connected to. */
export type BrowserTunnelFrameChannel = {
  // False when the frame was not written, e.g. while reconnecting.
  send: (frame: Uint8Array) => boolean
  onFrame: (listener: (frame: Uint8Array) => void) => () => void
}

export class BrowserTunnelFrameListeners {
  private readonly listeners = new Set<(frame: Uint8Array) => void>()

  add(listener: (frame: Uint8Array) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(frame: Uint8Array): void {
    for (const listener of this.listeners) {
      listener(frame)
    }
  }
}

/** Follows whichever socket is active. The host only answers frames the phone sent, so re-pointing on send
 *  never misses a frame from a new socket; late frames from an old one carry a stale tunnel generation. */
export class ActiveSessionBrowserTunnel implements BrowserTunnelFrameChannel {
  private readonly listeners = new BrowserTunnelFrameListeners()
  private source: BrowserTunnelFrameChannel | undefined
  private unlisten: (() => void) | undefined

  constructor(private readonly activeSession: () => RpcClient) {}

  send(frame: Uint8Array): boolean {
    const source = this.activeSession().browserTunnel
    if (source !== this.source) {
      this.unlisten?.()
      this.source = source
      this.unlisten = source?.onFrame((received) => this.listeners.emit(received))
    }
    return source?.send(frame) ?? false
  }

  onFrame(listener: (frame: Uint8Array) => void): () => void {
    return this.listeners.add(listener)
  }
}
