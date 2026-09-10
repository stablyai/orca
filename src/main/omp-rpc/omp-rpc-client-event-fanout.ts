// The client's event fanout, with one piece of retained state: the first fatal
// frame.
//
// Why retain it here rather than only in OmpRpcChatSession (XLR-R6-001,
// cross-lab review): the session wrapper is the retainer for the renderer's
// asynchronous subscribe, but it does not exist until acquisition's last await
// resolves — and OMP can emit a valid command response and then a fatal frame
// out of the SAME stdout chunk. The response resolves the pending command, the
// fault fires before the awaiting acquire continuation runs, and the frame
// reached no listener at all: the registry then stored an unusable client while
// the pane stayed 'acquired', routing sends to a dead child instead of asking
// for the PTY acquisition had already killed.
//
// A fatal frame is terminal state, not a stream event, so replaying it to a
// late subscriber is correct and only the FIRST one is kept. `clear()` (the
// exit path's listener teardown) drops subscribers but never that state, which
// is exactly what makes a subscription attempted after the exit still true.

import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'

type OmpRpcFatalEvent = Extract<OmpRpcClientEvent, { kind: 'exit' | 'protocol-fault' }>

export class OmpRpcClientEventFanout {
  private readonly listeners = new Set<(event: OmpRpcClientEvent) => void>()
  private fatalEvent: OmpRpcFatalEvent | null = null

  on(listener: (event: OmpRpcClientEvent) => void): () => void {
    this.listeners.add(listener)
    if (this.fatalEvent) {
      listener(this.fatalEvent)
    }
    return () => this.listeners.delete(listener)
  }

  emit(event: OmpRpcClientEvent): void {
    if (event.kind === 'exit' || event.kind === 'protocol-fault') {
      this.fatalEvent ??= event
    }
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
