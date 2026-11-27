import { AGENT_SESSION_ATTACHMENT_CHUNK_BYTES } from '../../../../src/shared/agent-session/agent-session-attachments'
import { encodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'

/** Regroups a file's bytes into host-sized appends; an empty file still sends the one empty append commit needs. */
export async function* agentSessionAttachmentByteAppends(
  bytes: AsyncIterable<Uint8Array>
): AsyncGenerator<{ offset: number; contentBase64: string }> {
  const staging = new Uint8Array(AGENT_SESSION_ATTACHMENT_CHUNK_BYTES)
  let staged = 0
  let offset = 0
  for await (const piece of bytes) {
    let read = 0
    while (read < piece.byteLength) {
      const copied = Math.min(staging.byteLength - staged, piece.byteLength - read)
      staging.set(piece.subarray(read, read + copied), staged)
      staged += copied
      read += copied
      if (staged === staging.byteLength) {
        yield { offset, contentBase64: encodeBase64Bytes(staging) }
        offset += staged
        staged = 0
      }
    }
  }
  if (staged > 0 || offset === 0) {
    yield { offset, contentBase64: encodeBase64Bytes(staging.subarray(0, staged)) }
  }
}
