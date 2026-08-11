import type { WebSocket } from 'ws'
import type { RpcRequest, RpcRespond, RpcResponse } from './mock-server-rpc-handlers'
import {
  createMockTerminals,
  FAKE_SCROLLBACK,
  STREAMING_CHUNKS
} from './mock-server-terminal-fixtures'

// Why: the client resubscribes on every viewport change; without cancellation
// each resubscribe would stack another interval streaming under a dead request.
type TerminalStream = { interval: ReturnType<typeof setInterval> | null }
const terminalStreams = new WeakMap<WebSocket, Map<string, TerminalStream>>()

function clearTerminalStream(ws: WebSocket, terminal: string): void {
  const perTerminal = terminalStreams.get(ws)
  const stream = perTerminal?.get(terminal)
  if (stream) {
    stopTerminalStreamInterval(stream)
    perTerminal?.delete(terminal)
  }
}

function beginTerminalStream(ws: WebSocket, terminal: string): TerminalStream {
  clearTerminalStream(ws, terminal)
  let perTerminal = terminalStreams.get(ws)
  if (!perTerminal) {
    perTerminal = new Map()
    terminalStreams.set(ws, perTerminal)
  }
  const stream = { interval: null }
  perTerminal.set(terminal, stream)
  return stream
}

function isCurrentTerminalStream(ws: WebSocket, terminal: string, stream: TerminalStream): boolean {
  return terminalStreams.get(ws)?.get(terminal) === stream && ws.readyState === ws.OPEN
}

function stopTerminalStreamInterval(stream: TerminalStream): void {
  if (stream.interval !== null) {
    clearInterval(stream.interval)
    stream.interval = null
  }
}

/** Terminal list/stream/input backend for the mock server. Returns false for
 *  methods it does not own. */
export function handleMockTerminalRequest(
  request: RpcRequest,
  respond: RpcRespond,
  success: (id: string, result: unknown, streaming?: boolean) => RpcResponse,
  ws: WebSocket,
  // Shared with `session.tabs.list` so both surfaces agree on which worktree an
  // absent or `id:`-prefixed selector means.
  resolveWorktreeId: (selector: unknown) => string | undefined
): boolean {
  switch (request.method) {
    case 'terminal.list': {
      const terminals = createMockTerminals(resolveWorktreeId(request.params?.worktree))
      respond(
        success(request.id, {
          terminals,
          totalCount: terminals.length,
          truncated: false
        })
      )
      return true
    }

    case 'terminal.subscribe': {
      const terminal = String(request.params?.terminal ?? 'term-1')
      const stream = beginTerminalStream(ws, terminal)
      const isCurrent = () => isCurrentTerminalStream(ws, terminal, stream)
      // Why: the client resubscribes until scrollback echoes its viewport dims;
      // the legacy `lines` shape left the session screen in that loop forever.
      const viewport = request.params?.viewport as { cols?: number; rows?: number } | undefined
      // MOCK_TUI=1 arms SGR drag mouse tracking (1002/1006) inside the scrollback
      // itself so every xterm re-init re-enters the mode - used by mouse/touch
      // input repros (#8818).
      const tuiPreamble =
        process.env.MOCK_TUI === '1'
          ? '\x1b[?1002h\x1b[?1006h[mock] mouse tracking ON (1002/1006)\r\n'
          : ''
      respond(
        success(request.id, {
          type: 'scrollback',
          cols: viewport?.cols ?? 80,
          rows: viewport?.rows ?? 24,
          serialized: FAKE_SCROLLBACK.replace(/\n/g, '\r\n') + tuiPreamble,
          truncated: false
        }),
        isCurrent
      )

      let chunkIndex = 0
      stream.interval = setInterval(() => {
        if (!isCurrent()) {
          stopTerminalStreamInterval(stream)
          return
        }
        if (chunkIndex >= STREAMING_CHUNKS.length) {
          // Why: no `end` event - a live terminal stream stays open, and `end`
          // makes the client tear the subscription down and blank the pane.
          stopTerminalStreamInterval(stream)
          return
        }
        respond(
          success(request.id, { type: 'data', chunk: STREAMING_CHUNKS[chunkIndex] }, true),
          isCurrent
        )
        chunkIndex++
      }, 500)
      return true
    }

    case 'terminal.send':
      // Input-routing repros (#8818) assert on the exact bytes reaching the host.
      console.log(
        `[SEND] terminal=${String(request.params?.terminal)} text=${JSON.stringify(request.params?.text)}`
      )
      respond(success(request.id, { send: { handle: 'term-1', ok: true } }))
      return true

    case 'terminal.unsubscribe':
      clearTerminalStream(ws, String(request.params?.terminal ?? 'term-1'))
      respond(success(request.id, { unsubscribed: true }))
      return true

    default:
      return false
  }
}
