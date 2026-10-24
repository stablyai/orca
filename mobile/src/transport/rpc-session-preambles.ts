import type { RpcEnvelopeFields } from './rpc-envelope-fields'

/** A request a transport leads every authenticated session with: see `RpcClient.setSessionPreamble`. */
export type RpcSessionPreamble = { method: string; params: unknown; envelope?: RpcEnvelopeFields }

/** The latest preamble per key, for a transport that opens many sessions over its life. */
export class RpcSessionPreambles {
  private readonly latest = new Map<string, RpcSessionPreamble>()

  // Fire and forget: no stream or request owns the frame's id, so its reply is dropped.
  constructor(private readonly send: (preamble: RpcSessionPreamble) => void) {}

  set(key: string, preamble: RpcSessionPreamble, connected: boolean): void {
    this.latest.set(key, preamble)
    if (connected) {
      this.send(preamble)
    }
  }

  /** On a new authenticated session, before anything replays into it. */
  sendAll(): void {
    for (const preamble of this.latest.values()) {
      this.send(preamble)
    }
  }
}
