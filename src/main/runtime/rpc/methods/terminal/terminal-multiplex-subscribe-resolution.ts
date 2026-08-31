import { TerminalStreamOpcode } from '../../../../../shared/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION,
  TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION,
  TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR
} from '../../../../../shared/terminal-multiplex-flow-control'
import type {
  MultiplexSubscribeRequest,
  TerminalMultiplexConnection
} from './terminal-multiplex-connection'

function finalizeResolvedMultiplexPty(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  leaf: { ptyId: string | null } | null
): string | null {
  if (!leaf?.ptyId) {
    state.sendStreamError(request.streamId, 'no_connected_pty')
    state.emit({ type: 'end', streamId: request.streamId })
    return null
  }
  if (state.closed) {
    return null
  }
  // Why: a competing subscribe may own this streamId after the PTY await; detach it so an orphaned view subscriber can't silence the model responder (terminal-query-authority.md).
  state.detachStream(request.streamId, false)
  if (state.streams.size >= TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION) {
    state.sendStreamError(request.streamId, TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR)
    state.emit({ type: 'end', streamId: request.streamId })
    return null
  }
  return leaf.ptyId
}

export function resolveMultiplexSubscribePty(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest
): string | null | Promise<string | null> {
  const { runtime, pendingPtyWaitControllers, registerBinaryStreamHandler, signal, emit } = state
  state.detachStream(request.streamId, false)
  state.cancelPendingPtyWaits(request.streamId)

  let leaf: { ptyId: string | null } | null
  try {
    // Why: binding the stream to whatever PTY now occupies a stale handle's pane would mirror the wrong terminal (#7718).
    leaf = runtime.resolveLiveLeafForHandle(request.terminal)
  } catch {
    state.sendStreamError(request.streamId, 'terminal_handle_stale')
    emit({ type: 'end', streamId: request.streamId })
    return null
  }
  if (leaf?.ptyId || !request.client) {
    return finalizeResolvedMultiplexPty(state, request, leaf)
  }
  if (pendingPtyWaitControllers.size >= TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION) {
    state.sendStreamError(request.streamId, TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR)
    emit({ type: 'end', streamId: request.streamId })
    return null
  }

  // Why: a never-mounted tab has no graph leaf to await; mounting the exact tab attaches its PTY without activating the worktree.
  runtime.requestRendererTerminalTabMount(request.terminal)
  const waitController = new AbortController()
  const pendingControllers = pendingPtyWaitControllers.get(request.streamId) ?? new Set()
  pendingControllers.add(waitController)
  pendingPtyWaitControllers.set(request.streamId, pendingControllers)
  if (signal?.aborted) {
    waitController.abort()
  }
  // Why: the live slot handler does not exist until the PTY attaches; retain cancellation ownership while the pane is still pending.
  const unregisterPendingHandler = registerBinaryStreamHandler(request.streamId, (frame) => {
    if (frame.opcode === TerminalStreamOpcode.Unsubscribe) {
      state.cancelPendingPtyWaits(request.streamId)
      state.detachStream(request.streamId, false)
    }
  })
  return (async () => {
    try {
      const ptyId = await runtime.waitForLeafPtyId(request.terminal, 10_000, waitController.signal)
      leaf = { ptyId }
    } catch {
      if (state.closed || signal?.aborted || waitController.signal.aborted) {
        return null
      }
      // Fall through to the explicit no_connected_pty error below.
    } finally {
      const currentControllers = pendingPtyWaitControllers.get(request.streamId)
      currentControllers?.delete(waitController)
      if (currentControllers?.size === 0) {
        pendingPtyWaitControllers.delete(request.streamId)
      }
      unregisterPendingHandler()
    }
    return finalizeResolvedMultiplexPty(state, request, leaf)
  })()
}
