// Model only observable staging/read/eof/release behavior with real verb schemas; native-media tests own device and cache details.
import {
  BRIDGE_MEDIA_READ_MAX_BYTES,
  mediaNameParamsSchema,
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
  readonly name?: string
}

export type MediaTestShell = {
  readonly calls: string[]
  readonly released: string[]
  readonly serveNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
}

// Offset-derived bytes expose reordered chunks and dropped boundaries without relying on length.
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
  readonly staged: Readonly<Partial<Record<string, readonly StagedTestMedia[]>>>
  readonly refusePick?: BridgeNativeVerbRefusedError
  // Short reads are legal; only eof promises completion.
  readonly chunkBytes?: number
  // Simulate premature eof so callers cannot silently upload a truncated file.
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
        // Parse the real verb schema so this fake cannot accept params the device would refuse.
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
      if (verb === 'native.media.name') {
        const { handle } = mediaNameParamsSchema.parse(params)
        calls.push(`name ${handle}`)
        return Promise.resolve({ name: hold(handle).name ?? null })
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
