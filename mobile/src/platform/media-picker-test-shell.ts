/**
 * A shell that stages media the way the real one does, for the page-side seam tests.
 *
 * Only what the seam can observe: a handle per picked item, a ranged read bounded by the same cap
 * the verb schema holds a page to, `eof` on the last chunk, and a refusal for a handle that has
 * been released. Everything the device half owns — pickers, permissions, the cache directory — is
 * the `native-media.ts` suite's, and duplicating it here would be a second shell to keep true.
 */
import {
  BRIDGE_MEDIA_READ_MAX_BYTES,
  mediaPickParamsSchema,
  mediaReadParamsSchema,
  mediaReleaseParamsSchema,
  type BridgeMediaItem
} from '../mobile-web-shell/bridge/bridge-media-verbs'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'

export type StagedTestMedia = {
  readonly bytes: Uint8Array
  readonly mime?: string
  readonly width?: number
  readonly height?: number
}

export type MediaTestShell = {
  /** Every verb call the page made, in order, as `verb offset:length` where a read says so. */
  readonly calls: string[]
  /** Handles this shell no longer holds, in release order. */
  readonly released: string[]
  readonly serveNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
}

/** Deterministic bytes: a run of the file's own offsets, so a chunk assembled out of order or a
 *  boundary dropped shows up as a different byte rather than a different length. */
export function stagedTestBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 31 + 7) % 251
  }
  return bytes
}

export function encodeTestBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function createMediaTestShell(options: {
  /** What each `pick` answers, by source. A source with no entry answers nothing, which is the
   *  cancelled picker. */
  readonly staged: Readonly<Partial<Record<string, readonly StagedTestMedia[]>>>
  /** Refuses the pick instead of answering it, for the arms where the shell says no. */
  readonly refusePick?: BridgeNativeVerbRefusedError
  /** Answers at most this many bytes per read, whatever was asked. A shell is only promised to
   *  report `eof` honestly, so a page must read a short chunk as a short chunk. */
  readonly chunkBytes?: number
  /** Reports `eof` after this many bytes, short of what `pick` declared: a staged file the shell
   *  lost track of, which a page must name rather than upload half of. */
  readonly endAt?: number
}): MediaTestShell {
  const calls: string[] = []
  const released: string[] = []
  const live = new Map<string, StagedTestMedia>()
  let minted = 0

  function hold(handle: string): StagedTestMedia {
    const record = live.get(handle)
    if (record === undefined) {
      throw new BridgeNativeVerbRefusedError(
        'native_media_handle_unknown',
        'this session holds no staged item under that handle'
      )
    }
    return record
  }

  return {
    calls,
    released,
    serveNativeVerb: (verb, params) => {
      if (verb === 'native.media.pick') {
        // Parsed with the verb's own schema, as the device handler does: a page that sent a
        // param shape the shell would have refused must not be served here either.
        const { source, multiple } = mediaPickParamsSchema.parse(params)
        calls.push(`pick ${source} ${multiple ? 'multiple' : 'single'}`)
        if (options.refusePick) {
          return Promise.reject(options.refusePick)
        }
        const items: BridgeMediaItem[] = (options.staged[source] ?? []).map((item) => {
          minted += 1
          const handle = `media-${minted}`
          live.set(handle, item)
          return {
            handle,
            mime: item.mime ?? 'image/png',
            byteLength: item.bytes.byteLength,
            ...(item.width === undefined ? {} : { width: item.width }),
            ...(item.height === undefined ? {} : { height: item.height })
          }
        })
        return Promise.resolve({ items })
      }
      if (verb === 'native.media.read') {
        const { handle, offset, length } = mediaReadParamsSchema.parse(params)
        calls.push(`read ${handle} ${offset}:${length}`)
        const record = hold(handle)
        const served = Math.min(length, BRIDGE_MEDIA_READ_MAX_BYTES, options.chunkBytes ?? length)
        const last = options.endAt ?? record.bytes.byteLength
        const end = Math.min(offset + served, last)
        return Promise.resolve({
          base64: encodeTestBase64(record.bytes.subarray(offset, end)),
          eof: end >= last
        })
      }
      const { handle } = mediaReleaseParamsSchema.parse(params)
      calls.push(`release ${handle}`)
      const held = live.delete(handle)
      if (held) {
        released.push(handle)
      }
      return Promise.resolve({ released: held })
    }
  }
}
