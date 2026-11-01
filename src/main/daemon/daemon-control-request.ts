import { readTerminalStartFailure } from '../../shared/terminal-start-failure'
import type { Socket } from 'node:net'
import { NOTIFY_PREFIX, type DaemonRequest } from './types'
import { encodeNdjson } from './ndjson'

export async function answerDaemonControlRequest(
  socket: Socket,
  request: DaemonRequest,
  route: () => Promise<unknown>,
  onReply: () => void
): Promise<void> {
  const isNotify = request.id.startsWith(NOTIFY_PREFIX)
  try {
    const result = await route()
    if (!isNotify) {
      socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }), onReply)
    }
  } catch (error) {
    if (!isNotify) {
      socket.write(
        encodeNdjson({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(readTerminalStartFailure(error)
            ? { terminalStartFailure: readTerminalStartFailure(error) }
            : {})
        })
      )
    }
  }
}
