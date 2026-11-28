import type { Socket } from 'node:net'
import { deserialize, serialize } from 'node:v8'

const MAX_FRAME = 32 * 1024 * 1024
export function sendProtectedFrame(socket: Socket, value: unknown): Promise<void> {
  const bytes = serialize(value)
  if (!bytes.length || bytes.length > MAX_FRAME) {
    throw new Error('invalid protected journal frame size')
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  return new Promise((resolve, reject) =>
    socket.write(Buffer.concat([size, bytes]), (err) => (err ? reject(err) : resolve()))
  )
}

export async function* protectedFrames(socket: Socket): AsyncGenerator<unknown> {
  let header = Buffer.alloc(4),
    used = 0,
    body: Buffer | undefined
  for await (const chunk of socket) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('invalid protected journal wire bytes')
    }
    let at = 0
    while (at < chunk.length) {
      const target = body ?? header
      const n = chunk.copy(target, used, at, at + Math.min(target.length - used, chunk.length - at))
      at += n
      used += n
      if (used !== target.length) {
        continue
      }
      used = 0
      if (body) {
        const result: unknown = deserialize(body)
        body = undefined
        yield result
      } else {
        const length = header.readUInt32BE()
        if (!length || length > MAX_FRAME) {
          throw new Error('invalid protected journal frame size')
        }
        body = Buffer.alloc(length)
      }
    }
  }
  if (used || body) {
    throw new Error('truncated protected journal frame')
  }
}
