// Chrome's limit on one message from a host.
const MAX_HOST_MESSAGE_BYTES = 1024 * 1024
const HEADER_BYTES = 4

/** A message on the wire: a 4-byte length in native order (little-endian on every platform Orca ships), then UTF-8 JSON. */
export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message ?? null), 'utf8')
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

/** Splits a host's stdout into messages; throws on one over Chrome's size limit. */
export function createNativeMessageReader(onMessage: (message: unknown) => void) {
  let pending = Buffer.alloc(0)
  return (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= HEADER_BYTES) {
      const length = pending.readUInt32LE(0)
      if (length > MAX_HOST_MESSAGE_BYTES) {
        throw new Error('Native host message is too large')
      }
      if (pending.length < HEADER_BYTES + length) {
        return
      }
      const body = pending.subarray(HEADER_BYTES, HEADER_BYTES + length)
      pending = pending.subarray(HEADER_BYTES + length)
      onMessage(JSON.parse(body.toString('utf8')))
    }
  }
}
