import { readTerminalStartFailure } from '../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import type { Socket } from 'node:net'
import { NOTIFY_PREFIX, type DaemonRequest } from '../protocol/daemon-rpc-contract'
import { encodeNdjson } from '../../../shared/main-process-ndjson-framer'
import { takePreparedReply, type PreparedDaemonReply } from './daemon-reply-obligation'

export async function answerDaemonControlRequest(
  socket: Socket,
  request: DaemonRequest,
  route: () => Promise<unknown>,
  onReply: () => void
): Promise<void> {
  const isNotify = request.id.startsWith(NOTIFY_PREFIX)
  let owned: PreparedDaemonReply | undefined
  let line: string
  let replied: (() => void) | undefined
  try {
    const result = await route()
    owned = takePreparedReply(result)
    if (isNotify) {
      return owned?.release()
    }
    line = owned?.line ?? encodeNdjson({ id: request.id, ok: true, payload: result })
    replied = onReply
  } catch (error) {
    owned ??= takePreparedReply(error)
    if (isNotify) {
      return owned?.release()
    }
    try {
      line = encodeNdjson({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(readTerminalStartFailure(error)
          ? { terminalStartFailure: readTerminalStartFailure(error) }
          : {})
      })
    } catch {
      // Never recurse into another error frame.
      return owned?.release()
    }
  }
  writeOwnedReply(socket, line, owned, replied)
}

/** Holds the reply's resources until the write settles or the socket closes, exactly once. */
function writeOwnedReply(
  socket: Socket,
  line: string,
  owned: PreparedDaemonReply | undefined,
  onReply: (() => void) | undefined
): void {
  if (owned && socket.destroyed) {
    // A connection that already closed can never settle a write.
    return owned.release()
  }
  let settled = false
  const settle = (): void => {
    if (!settled) {
      settled = true
      socket.off('close', settle)
      owned?.release()
    }
  }
  if (owned) {
    socket.once('close', settle)
  }
  try {
    socket.write(line, () => {
      settle()
      onReply?.()
    })
  } catch {
    settle()
  }
}
