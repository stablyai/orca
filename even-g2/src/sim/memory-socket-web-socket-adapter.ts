// Sim/test glue (Unit 8): adapts a MemorySocketLike (memory-socket-pair.ts) to the WebSocketLike
// shape OrcaSocketClient's socketFactory expects. The two interfaces differ slightly (readyState
// vs none, event payload shapes), so this is a thin explicit bridge rather than relying on
// structural inference — used by sim-entry.ts and the *.integration.test.ts suites.
import type { MemorySocketLike } from './memory-socket-pair'
import type { WebSocketLike } from '../transport/orca-socket-client'

export function toWebSocketLike(socket: MemorySocketLike): WebSocketLike {
  const adapter: WebSocketLike = {
    send: (data) => socket.send(data as string | ArrayBuffer | ArrayBufferView),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    binaryType: socket.binaryType
  }
  socket.onopen = () => adapter.onopen?.(undefined)
  socket.onmessage = (event) => adapter.onmessage?.({ data: event.data })
  socket.onclose = (event) => adapter.onclose?.(event)
  socket.onerror = (event) => adapter.onerror?.(event)
  return adapter
}
