import type { Socket } from 'node:net'
import { buildRuntimeRpcConnectionLimitFailure } from '../../../shared/runtime-rpc-connection-limit'

// Why: a rejected socket must not hold a descriptor past a short window, replied or not.
const BUSY_REPLY_DEADLINE_MS = 2_000
// Why: bounds memory per rejected socket well below the 1MB request cap; the id is all we need.
const BUSY_REPLY_MAX_READ_BYTES = 64 * 1024
// Why: the CLI serialises `id` first, so an over-long line still names its request.
const LEADING_REQUEST_ID = /^\s*\{\s*"id"\s*:\s*"([^"\\]{1,256})"/

/** Answers an over-limit connection with runtime_busy for its request id. Never dispatches. */
export function replyConnectionLimitBusy(socket: Socket): void {
  let buffer = ''
  let bufferedBytes = 0
  let replied = false
  let deadline = setTimeout(() => socket.destroy(), BUSY_REPLY_DEADLINE_MS)
  deadline.unref?.()

  socket.setEncoding('utf8')
  socket.on('error', () => {
    socket.destroy()
  })
  socket.once('close', () => {
    clearTimeout(deadline)
  })
  socket.on('data', (chunk: string) => {
    // Why: keep draining after the reply so a client still writing its request doesn't hit EPIPE before reading it.
    if (replied) {
      return
    }
    buffer += chunk
    bufferedBytes += Buffer.byteLength(chunk, 'utf8')
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1 && bufferedBytes < BUSY_REPLY_MAX_READ_BYTES) {
      return
    }
    const id =
      newlineIndex === -1
        ? readLeadingRequestId(buffer)
        : readRequestId(buffer.slice(0, newlineIndex))
    buffer = ''
    if (!id) {
      socket.destroy()
      return
    }
    replied = true
    socket.end(`${JSON.stringify(buildRuntimeRpcConnectionLimitFailure(id))}\n`)
    clearTimeout(deadline)
    deadline = setTimeout(() => socket.destroy(), BUSY_REPLY_DEADLINE_MS)
    deadline.unref?.()
  })
}

function readRequestId(line: string): string | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
      return typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null
    }
    return null
  } catch {
    return null
  }
}

function readLeadingRequestId(prefix: string): string | null {
  return LEADING_REQUEST_ID.exec(prefix)?.[1] ?? null
}
