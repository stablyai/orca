import { endianness } from 'node:os'

/**
 * Chrome's native messaging wire format: each message is a 32-bit length in the machine's native
 * byte order followed by that many bytes of UTF-8 JSON.
 */

const HEADER_BYTES = 4
/** Chrome refuses host → extension messages over 1 MB (kMaximumNativeMessageSize). */
export const MAX_NATIVE_HOST_MESSAGE_BYTES = 1024 * 1024

const littleEndian = endianness() === 'LE'

export function encodeNativeHostMessage(json: string): Buffer {
  const body = Buffer.from(json, 'utf8')
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  if (littleEndian) {
    frame.writeUInt32LE(body.length, 0)
  } else {
    frame.writeUInt32BE(body.length, 0)
  }
  body.copy(frame, HEADER_BYTES)
  return frame
}

export type NativeHostMessageReader = {
  /** Feeds one stdout chunk; returns false once the stream is unusable (the reader stops). */
  push: (chunk: Buffer) => boolean
}

/**
 * Reassembles messages across stdout chunks. `onMessage` gets the JSON text, already checked to
 * parse; an oversized or malformed message calls `onError` once and stops the reader.
 */
export function createNativeHostMessageReader(
  onMessage: (json: string) => void,
  onError: (reason: string) => void
): NativeHostMessageReader {
  let pending: Buffer[] = []
  let pendingBytes = 0
  let failed = false

  const fail = (reason: string): false => {
    failed = true
    pending = []
    pendingBytes = 0
    onError(reason)
    return false
  }

  const readSize = (): number => {
    const head =
      pending[0].length >= HEADER_BYTES ? pending[0] : Buffer.concat(pending, pendingBytes)
    return littleEndian ? head.readUInt32LE(0) : head.readUInt32BE(0)
  }

  return {
    push: (chunk) => {
      if (failed) {
        return false
      }
      pending.push(chunk)
      pendingBytes += chunk.length
      while (pendingBytes >= HEADER_BYTES) {
        const size = readSize()
        if (size > MAX_NATIVE_HOST_MESSAGE_BYTES) {
          return fail(`message of ${size} bytes is over the 1 MB limit`)
        }
        if (pendingBytes < HEADER_BYTES + size) {
          return true
        }
        // Why concat only now: a 1 MB message arrives in many chunks; joining each time is quadratic.
        const buffered = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
        const json = buffered.toString('utf8', HEADER_BYTES, HEADER_BYTES + size)
        const rest = buffered.subarray(HEADER_BYTES + size)
        pending = rest.length > 0 ? [rest] : []
        pendingBytes = rest.length
        try {
          JSON.parse(json)
        } catch {
          return fail('message is not valid JSON')
        }
        onMessage(json)
      }
      return true
    }
  }
}
