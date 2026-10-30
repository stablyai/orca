import { TerminalStreamOpcode } from '../../../../../shared/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION,
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
  // If another subscribe replaced this slot during await, detach the orphan or it silences the model responder (terminal-query-authority.md).
  state.detachStream(request.streamId, null)
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
  const {
    runtime,
    pendingPtyWaitControllers,
    ptyWaitAdmission,
    registerBinaryStreamHandler,
    signal,
    emit
  } = state
  state.detachStream(request.streamId, null)
  state.cancelPendingPtyWaits(request.streamId)

  let leaf: { ptyId: string | null } | null
  try {
    // Never bind stale handles to a pane's replacement PTY (#7718).
    leaf = runtime.resolveLiveLeafForHandle(request.terminal)
  } catch {
    state.sendStreamError(request.streamId, 'terminal_handle_stale')
    emit({ type: 'end', streamId: request.streamId })
    return null
  }
  if (leaf?.ptyId || !request.client) {
    return finalizeResolvedMultiplexPty(state, request, leaf)
  }
  if (!ptyWaitAdmission.hasRoom()) {
    state.sendStreamError(request.streamId, TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR)
    emit({ type: 'end', streamId: request.streamId })
    return null
  }

  const waitController = new AbortController()
  const pendingControllers = pendingPtyWaitControllers.get(request.streamId) ?? new Set()
  pendingControllers.add(waitController)
  pendingPtyWaitControllers.set(request.streamId, pendingControllers)
  if (signal?.aborted) {
    waitController.abort()
  }
  // Keep cancellation ownership until PTY attachment installs the live handler.
  const unregisterPendingHandler = registerBinaryStreamHandler(request.streamId, (frame) => {
    if (frame.opcode === TerminalStreamOpcode.Unsubscribe) {
      state.cancelPendingPtyWaits(request.streamId)
      state.detachStream(request.streamId, null)
    }
  })
  return (async () => {
    let admitted = false
    try {
      admitted = await ptyWaitAdmission.acquire(waitController.signal)
      if (!admitted || waitController.signal.aborted) {
        return null
      }
      // Mount the exact never-viewed tab to create its graph leaf and PTY without activating its workspace.
      runtime.requestRendererTerminalTabMount(request.terminal)
      const ptyId = await runtime.waitForLeafPtyId(request.terminal, 10_000, waitController.signal)
      leaf = { ptyId }
    } catch {
      if (state.closed || signal?.aborted || waitController.signal.aborted) {
        return null
      }
    } finally {
      if (admitted) {
        ptyWaitAdmission.release()
      }
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
