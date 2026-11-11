import { AGENT_SESSION_ATTACHMENT_CHUNK_BYTES } from '../../../../src/shared/agent-session/agent-session-attachments'
import { encodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'
import { BRIDGE_MEDIA_READ_MAX_BYTES, type BridgeMediaItem } from './bridge-media-verbs'
import type { NativeVerbs } from './use-native-verbs'
import { MobileImageBase64Accumulator } from '../../files/attachments/mobile-image-base64-accumulator'

// Share chunked media reads across picker and clipboard; 18 MiB raw images exceed the 8 MiB reply ceiling and must stay behind handles until read.

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

// Join decoded bytes, then encode once; concatenated base64 chunks can put padding inside the file. Ask within the shell’s own chunk cap.
export async function readStagedMediaItem(
  verbs: NativeVerbs,
  item: BridgeMediaItem
): Promise<string> {
  const accumulator = new MobileImageBase64Accumulator()
  let offset = 0
  for (;;) {
    // Even empty items need one read to learn eof; the schema refuses zero-length requests.
    const length = Math.max(1, Math.min(BRIDGE_MEDIA_READ_MAX_BYTES, item.byteLength - offset))
    const chunk = await verbs.readMedia(item.handle, offset, length)
    const bytes = decodeBase64(chunk.base64)
    accumulator.append(bytes)
    offset += bytes.byteLength
    if (chunk.eof) {
      break
    }
    if (bytes.byteLength === 0) {
      // No bytes without eof cannot progress; fail rather than loop forever.
      throw new Error(`the shell answered no bytes for ${item.handle} and did not report the end`)
    }
  }
  if (offset !== item.byteLength) {
    throw new Error(
      `the shell answered ${offset} bytes for an item it declared as ${item.byteLength}`
    )
  }
  return accumulator.finish()
}

// Stream an item as upload-sized base64 chunks without holding the file. Short shell reads are regrouped so every chunk but the last is exactly one upload chunk (a multiple of three bytes, so padding appears only at the end). The caller owns the handle.
export async function* readStagedMediaChunks(
  verbs: NativeVerbs,
  item: BridgeMediaItem
): AsyncGenerator<string> {
  let carry = new Uint8Array(0)
  let offset = 0
  for (;;) {
    // Even empty items need one read to learn eof; the schema refuses zero-length requests.
    const length = Math.max(
      1,
      Math.min(
        BRIDGE_MEDIA_READ_MAX_BYTES,
        AGENT_SESSION_ATTACHMENT_CHUNK_BYTES,
        item.byteLength - offset
      )
    )
    const chunk = await verbs.readMedia(item.handle, offset, length)
    const bytes = decodeBase64(chunk.base64)
    offset += bytes.byteLength
    if (bytes.byteLength > 0) {
      const joined = new Uint8Array(carry.byteLength + bytes.byteLength)
      joined.set(carry)
      joined.set(bytes, carry.byteLength)
      let start = 0
      while (joined.byteLength - start >= AGENT_SESSION_ATTACHMENT_CHUNK_BYTES) {
        yield encodeBase64Bytes(
          joined.subarray(start, start + AGENT_SESSION_ATTACHMENT_CHUNK_BYTES)
        )
        start += AGENT_SESSION_ATTACHMENT_CHUNK_BYTES
      }
      carry = joined.slice(start)
    }
    if (chunk.eof) {
      break
    }
    if (bytes.byteLength === 0) {
      throw new Error(`the shell answered no bytes for ${item.handle} and did not report the end`)
    }
  }
  if (offset !== item.byteLength) {
    throw new Error(
      `the shell answered ${offset} bytes for an item it declared as ${item.byteLength}`
    )
  }
  if (carry.byteLength > 0) {
    yield encodeBase64Bytes(carry)
  }
}

// Keep finally cleanup quiet so it cannot replace the original read refusal.
export async function releaseStagedMedia(verbs: NativeVerbs, handle: string): Promise<void> {
  try {
    await verbs.releaseMedia(handle)
  } catch (error) {
    console.warn('[page] a staged media handle could not be released', { handle }, error)
  }
}

// Release every returned handle, even when multiple:false was requested; extra items otherwise consume the eight-handle cap until expiry.
export async function releaseAllStagedMedia(
  verbs: NativeVerbs,
  items: readonly BridgeMediaItem[]
): Promise<void> {
  for (const item of items) {
    await releaseStagedMedia(verbs, item.handle)
  }
}
