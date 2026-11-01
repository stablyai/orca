import {
  BRIDGE_MEDIA_NAME_MAX_CHARS,
  BRIDGE_MEDIA_READ_MAX_BYTES,
  mediaNameParamsSchema,
  mediaPickParamsSchema,
  mediaReadParamsSchema,
  mediaReleaseParamsSchema,
  type BridgeMediaSource
} from '../mobile-web-shell/bridge/bridge-media-verbs'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import {
  MEDIA_STAGED_MAX_BYTES,
  type MediaHandleRegistry,
  type StagedMedia
} from '../mobile-web-shell/media-handle-registry'
import { MobileImageBase64Accumulator } from '../session/mobile-image-base64-accumulator'

// Stage native media behind handles because raw/base64 image sizes exceed reply caps; inject device calls to test provider/cancel/size failures.

export type NativeMediaFileHandle = {
  offset: number | null
  readBytes: (length: number) => Uint8Array
  close: () => void
}

export type NativeMediaFile = {
  readonly size: number
  open: () => NativeMediaFileHandle
}

type PickedAsset = {
  readonly uri: string
  readonly mimeType?: string | null
  readonly width?: number
  readonly height?: number
  readonly name?: string | null
  readonly fileName?: string | null
}

type PickerResult = { readonly canceled: boolean; readonly assets?: readonly PickedAsset[] | null }

export type NativeMediaDeps = {
  readonly registry: MediaHandleRegistry
  // Bound selection by remaining registry room when the picker supports a limit.
  readonly launchLibrary: (options: { multiple: boolean; limit: number }) => Promise<PickerResult>
  readonly launchFiles: (options: { multiple: boolean; limit: number }) => Promise<PickerResult>
  readonly readClipboardImage: () => Promise<{
    readonly data: string
    readonly size?: { readonly width: number; readonly height: number }
  } | null>
  readonly stageBase64: (base64: string) => string
  readonly openFile: (uri: string) => NativeMediaFile
  readonly ownsStagedUri: (uri: string) => boolean
  readonly copyIntoCache: (uri: string) => string
  // Sweep refused picks before minting; no registry handle exists to own their cleanup.
  readonly discard: (uri: string) => void
}

const CLIPBOARD_STAGED_MIME = 'image/png'

const UNKNOWN_STAGED_MIME = 'application/octet-stream'

const DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i

export function createNativeMediaVerbServer(
  deps: NativeMediaDeps
): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  // Read authoritative staged-file sizes: picker metadata can be absent or wrong.
  function stage(assets: readonly PickedAsset[]): StagedMedia[] {
    const staged: StagedMedia[] = []
    // Delete only owned files; provider URIs are never ours to unlink.
    const owned: string[] = []
    try {
      for (const asset of assets) {
        const uri = adopt(asset, owned)
        const { size } = deps.openFile(uri)
        refuseOverStagingCeiling(size)
        const name = pickedName(asset)
        staged.push({
          uri,
          mime: asset.mimeType ?? UNKNOWN_STAGED_MIME,
          byteLength: size,
          ...(asset.width === undefined ? {} : { width: asset.width }),
          ...(asset.height === undefined ? {} : { height: asset.height }),
          ...(name === null ? {} : { name })
        })
      }
    } catch (error) {
      for (const uri of owned) {
        discardQuietly(uri)
      }
      throw error
    }
    return staged
  }

  // Adopt provider URIs into cache so release/TTL can delete the file without touching the provider’s original.
  function adopt(asset: PickedAsset, owned: string[]): string {
    if (deps.ownsStagedUri(asset.uri)) {
      owned.push(asset.uri)
      return asset.uri
    }
    // Weigh before copying: Expo content: reads are whole-file only. Provider size zero means unknown or empty, so refuse rather than allocate an unbounded item.
    const weighed = deps.openFile(asset.uri).size
    if (weighed <= 0) {
      throw new Error(`a picked item could not be weighed before reading it: ${asset.uri}`)
    }
    refuseOverStagingCeiling(weighed)
    const copy = deps.copyIntoCache(asset.uri)
    // Reject an unowned copy before recording ownership; neither it nor the provider’s original is ours to unlink.
    if (!deps.ownsStagedUri(copy)) {
      throw new Error(`a picker answered a uri this shell does not own: ${asset.uri}`)
    }
    owned.push(copy)
    return copy
  }

  function refuseOverStagingCeiling(size: number): void {
    if (size > MEDIA_STAGED_MAX_BYTES) {
      throw new BridgeNativeVerbRefusedError(
        'native_media_too_large',
        `a picked item is ${size} bytes, over the ${MEDIA_STAGED_MAX_BYTES} this shell stages`
      )
    }
  }

  function discardQuietly(uri: string): void {
    try {
      deps.discard(uri)
    } catch (error) {
      // Best-effort cache cleanup must not replace the original refusal.
      console.warn('[web-shell-bridge] a picked file could not be deleted', { uri }, error)
    }
  }

  async function pickFrom(
    source: BridgeMediaSource,
    multiple: boolean,
    isCurrent: () => boolean
  ): Promise<StagedMedia[]> {
    // Check room before the OS copies a selection that mint would refuse.
    const room = deps.registry.remainingCapacity()
    if (room <= 0) {
      throw new BridgeNativeVerbRefusedError(
        'native_media_handle_cap',
        'this page is holding every staged item it may; release one before picking again'
      )
    }
    if (source === 'clipboard') {
      const image = await deps.readClipboardImage()
      if (image === null || !isCurrent()) {
        return []
      }
      const base64 = image.data.replace(DATA_URL_PREFIX_RE, '')
      const uri = deps.stageBase64(base64)
      return stage([
        {
          uri,
          mimeType: CLIPBOARD_STAGED_MIME,
          ...(image.size === undefined
            ? {}
            : { width: image.size.width, height: image.size.height })
        }
      ])
    }
    // DocumentPicker ignores room; enforce count before staging any bytes.
    function withinRoom(assets: readonly PickedAsset[]): readonly PickedAsset[] {
      if (assets.length > room) {
        for (const asset of assets) {
          if (deps.ownsStagedUri(asset.uri)) {
            discardQuietly(asset.uri)
          }
        }
        throw new BridgeNativeVerbRefusedError(
          'native_media_handle_cap',
          `that pick answered ${assets.length} items and this page has room for ${room}`
        )
      }
      return assets
    }

    // Expo’s OS library picker needs no permission preflight; an extra denial could block a pick the OS would allow.
    const assets = readAssets(
      await (source === 'library'
        ? deps.launchLibrary({ multiple, limit: room })
        : deps.launchFiles({ multiple, limit: room }))
    )
    if (!isCurrent()) {
      for (const asset of assets) {
        if (deps.ownsStagedUri(asset.uri)) {
          discardQuietly(asset.uri)
        }
      }
      return []
    }
    return stage(withinRoom(assets))
  }

  // Decode chunks before joining; concatenating independently padded base64 corrupts the file.
  function readRange(uri: string, start: number, end: number): string {
    const handle = deps.openFile(uri).open()
    try {
      handle.offset = start
      const accumulator = new MobileImageBase64Accumulator()
      let read = start
      while (read < end) {
        const bytes = handle.readBytes(Math.min(BRIDGE_MEDIA_READ_MAX_BYTES, end - read))
        if (bytes.byteLength === 0) {
          break
        }
        read += bytes.byteLength
        accumulator.append(bytes)
      }
      return accumulator.finish()
    } finally {
      handle.close()
    }
  }

  return async (verb, params) => {
    if (verb === 'native.media.pick') {
      const { source, multiple } = mediaPickParamsSchema.parse(params)
      const generation = deps.registry.generation
      const isCurrent = (): boolean => deps.registry.generation === generation
      const staged = await pickFrom(source, multiple, isCurrent)
      if (!isCurrent()) {
        for (const item of staged) {
          discardQuietly(item.uri)
        }
        return { items: [] }
      }
      return { items: deps.registry.mint(staged) }
    }
    if (verb === 'native.media.read') {
      const { handle, offset, length } = mediaReadParamsSchema.parse(params)
      const range = deps.registry.read(handle, offset, length)
      return { base64: readRange(range.uri, range.start, range.end), eof: range.eof }
    }
    if (verb === 'native.media.name') {
      const { handle } = mediaNameParamsSchema.parse(params)
      return { name: deps.registry.name(handle) }
    }
    const { handle } = mediaReleaseParamsSchema.parse(params)
    return { released: deps.registry.release(handle) }
  }
}

function pickedName(asset: PickedAsset): string | null {
  const name = (asset.name ?? asset.fileName ?? '').trim()
  if (name.length === 0) {
    return null
  }
  if (name.length <= BRIDGE_MEDIA_NAME_MAX_CHARS) {
    return name
  }
  // Keep a short extension because agents infer file type from it.
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
  return name.slice(0, BRIDGE_MEDIA_NAME_MAX_CHARS - extension.length) + extension
}

function readAssets(result: PickerResult): readonly PickedAsset[] {
  return result.canceled ? [] : (result.assets ?? [])
}
