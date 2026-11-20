import { encodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'
import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BYTES,
  agentSessionAttachmentAppends
} from '../../../../src/shared/agent-session/agent-session-attachments'

// Slice an in-memory base64 string on upload-chunk boundaries so it matches streamed picks.
export async function* inMemoryBase64Chunks(base64: string): AsyncGenerator<string> {
  for (const append of agentSessionAttachmentAppends(base64)) {
    yield append.contentBase64
  }
}

// Slice a pasted file on upload-chunk boundaries; one chunk is in memory at a time.
export async function* blobBase64Chunks(blob: Blob): AsyncGenerator<string> {
  for (let start = 0; start < blob.size; start += AGENT_SESSION_ATTACHMENT_CHUNK_BYTES) {
    const bytes = new Uint8Array(
      await blob.slice(start, start + AGENT_SESSION_ATTACHMENT_CHUNK_BYTES).arrayBuffer()
    )
    yield encodeBase64Bytes(bytes)
  }
}
