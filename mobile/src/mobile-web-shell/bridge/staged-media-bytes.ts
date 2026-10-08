import { BRIDGE_MEDIA_READ_MAX_BYTES, type BridgeMediaItem } from './bridge-media-verbs'
import type { NativeVerbs } from './use-native-verbs'
import { MobileImageBase64Accumulator } from '../../session/mobile-image-base64-accumulator'

/**
 * Reading the bytes behind a staged media handle, and giving the handle back.
 *
 * Shared by the two page seams that pick: the media picker's library and Files arms, and the
 * clipboard's image read. A picked image reaches 18 MiB raw against an 8 MiB reply ceiling, so the
 * verbs hand over a handle and the bytes follow a chunk at a time; this is that loop, in one place
 * because two copies of it are two different answers to what `eof` means.
 */

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Every chunk of one staged item, concatenated as bytes and encoded once.
 *
 * Bytes and not strings: each chunk is base64 on its own, so only the last one may end on a partial
 * group, and a reader that joined the text would fold that padding into the middle of the file. The
 * cap the shell enforces is the same one asked for here, so a read never fails for being too large.
 */
export async function readStagedMediaItem(
  verbs: NativeVerbs,
  item: BridgeMediaItem
): Promise<string> {
  const accumulator = new MobileImageBase64Accumulator()
  let offset = 0
  for (;;) {
    // At least one byte, because an empty staged item still has to be read once to hear `eof`, and
    // the shell's schema refuses a zero-length read.
    const length = Math.max(1, Math.min(BRIDGE_MEDIA_READ_MAX_BYTES, item.byteLength - offset))
    const chunk = await verbs.readMedia(item.handle, offset, length)
    const bytes = decodeBase64(chunk.base64)
    accumulator.append(bytes)
    offset += bytes.byteLength
    if (chunk.eof) {
      break
    }
    if (bytes.byteLength === 0) {
      // Not `eof` and no bytes is a shell that would never finish. Named here rather than left to
      // spin, because the loop has no other exit.
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

/** Best effort, and deliberately quiet: this runs in a `finally`, where a throw would replace the
 *  refusal that brought us here with a complaint about cleaning up after it. */
export async function releaseStagedMedia(verbs: NativeVerbs, handle: string): Promise<void> {
  try {
    await verbs.releaseMedia(handle)
  } catch (error) {
    console.warn('[page] a staged media handle could not be released', { handle }, error)
  }
}

/**
 * Gives back every handle a pick answered, whatever became of the read.
 *
 * `multiple: false` is what a page asks for and not what a shell promises, so a caller taking the
 * first of several would hold the rest against the eight-handle cap until the TTL.
 */
export async function releaseAllStagedMedia(
  verbs: NativeVerbs,
  items: readonly BridgeMediaItem[]
): Promise<void> {
  for (const item of items) {
    await releaseStagedMedia(verbs, item.handle)
  }
}
