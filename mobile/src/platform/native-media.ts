import {
  BRIDGE_MEDIA_READ_MAX_BYTES,
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

/**
 * The device side of `native.media.pick`, `read` and `release`.
 *
 * The OS permission prompt runs here, inside the shell, which is the whole reason these are verbs:
 * a page served from a custom scheme has no photo library and no Files app, and a picker is the one
 * thing that cannot be handed over as a value. What crosses back is a handle — the bytes follow a
 * chunk at a time, because a picked image reaches `MEDIA_STAGED_MAX_BYTES` and that is three times
 * the reply ceiling.
 *
 * Every device call is injectable for the same reason the clipboard verb's is not: these four have
 * no honest fake inside `expo-image-picker`, and the arms worth pinning — a denied permission, a
 * cancel, an item over the ceiling — are exactly the ones a simulator makes expensive.
 */

/** A staged file as this handler reads it: the shape `expo-file-system`'s `File` already has. */
export type NativeMediaFileHandle = {
  offset: number | null
  readBytes: (length: number) => Uint8Array
  close: () => void
}

export type NativeMediaFile = {
  readonly size: number
  open: () => NativeMediaFileHandle
}

/** One asset a picker handed back, in the shape both pickers agree on. */
type PickedAsset = {
  readonly uri: string
  readonly mimeType?: string | null
  readonly width?: number
  readonly height?: number
}

type PickerResult = { readonly canceled: boolean; readonly assets?: readonly PickedAsset[] | null }

export type NativeMediaDeps = {
  readonly registry: MediaHandleRegistry
  readonly requestLibraryPermission: () => Promise<{ readonly granted: boolean }>
  readonly launchLibrary: (options: { multiple: boolean }) => Promise<PickerResult>
  readonly launchFiles: (options: { multiple: boolean }) => Promise<PickerResult>
  readonly readClipboardImage: () => Promise<{
    readonly data: string
    readonly size?: { readonly width: number; readonly height: number }
  } | null>
  /** Writes base64 into a cache file this shell owns and answers its uri. */
  readonly stageBase64: (base64: string) => string
  readonly openFile: (uri: string) => NativeMediaFile
  /** Whether this shell can size and delete what that uri names. */
  readonly ownsStagedUri: (uri: string) => boolean
  /** Copies what a uri names into a cache file this shell owns, and answers that file's uri. */
  readonly copyIntoCache: (uri: string) => string
  /** Deletes one staged file. The registry owns the ones it minted; this is for the pick that
   *  was refused before a handle existed, whose files nothing else would ever sweep. */
  readonly discard: (uri: string) => void
}

/** What the pasteboard hands back is always re-encoded PNG, whatever was copied. */
const CLIPBOARD_STAGED_MIME = 'image/png'

/** A picker that reports no type. `pick` must answer a mime, and this is the honest floor. */
const UNKNOWN_STAGED_MIME = 'application/octet-stream'

const DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i

export function createNativeMediaVerbServer(
  deps: NativeMediaDeps
): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  /**
   * Weighs each picked file and names it, or refuses the pick and takes its files with it.
   *
   * The size is read from the staged file rather than from what the picker declared: a picker's
   * `size` is optional on both platforms and absent on some providers, and the ceiling is the one
   * bound standing between a 4K video and 60 MiB of cache the shell never asked for.
   */
  function stage(assets: readonly PickedAsset[]): StagedMedia[] {
    const staged: StagedMedia[] = []
    /** Only what this shell owns. A provider's own uri is never ours to unlink. */
    const owned: string[] = []
    try {
      for (const asset of assets) {
        // The handle contract rests on the file being ours: `release` is a delete and so is the
        // TTL sweep. Both pickers normally answer a copy in this app's cache, and Android's image
        // library has one arm that does not — `MediaHandler.readExtras` answers the provider's own
        // uri when the resolver cannot type the asset. The OS completed that pick, so it is copied
        // rather than refused; refusing would lose a photo the user chose.
        const uri = deps.ownsStagedUri(asset.uri) ? asset.uri : deps.copyIntoCache(asset.uri)
        owned.push(uri)
        // Still not ours: a scheme the copy could not adopt either. Fail closed here rather than
        // let a sweep that can never delete anything look like one that did.
        if (!deps.ownsStagedUri(uri)) {
          throw new Error(`a picker answered a uri this shell does not own: ${asset.uri}`)
        }
        const { size } = deps.openFile(uri)
        if (size > MEDIA_STAGED_MAX_BYTES) {
          throw new BridgeNativeVerbRefusedError(
            'native_media_too_large',
            `a picked item is ${size} bytes, over the ${MEDIA_STAGED_MAX_BYTES} this shell stages`
          )
        }
        staged.push({
          uri,
          mime: asset.mimeType ?? UNKNOWN_STAGED_MIME,
          byteLength: size,
          ...(asset.width === undefined ? {} : { width: asset.width }),
          ...(asset.height === undefined ? {} : { height: asset.height })
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

  function discardQuietly(uri: string): void {
    try {
      deps.discard(uri)
    } catch (error) {
      // Best effort: the picker's own copy may already be gone, and a file left behind is the
      // cache's problem rather than a reason to lose the refusal that brought us here.
      console.warn('[web-shell-bridge] a picked file could not be deleted', { uri }, error)
    }
  }

  async function pickFrom(source: BridgeMediaSource, multiple: boolean): Promise<StagedMedia[]> {
    if (source === 'clipboard') {
      const image = await deps.readClipboardImage()
      if (image === null) {
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
    if (source === 'library') {
      // `granted` covers full and limited iOS access; only a hard denial stops the pick, and it
      // gets a name of its own because a page showing "could not read your library" for a
      // permission the user can grant in Settings is the wrong thing on screen.
      const permission = await deps.requestLibraryPermission()
      if (!permission.granted) {
        throw new BridgeNativeVerbRefusedError(
          'native_media_permission_denied',
          'the photo library permission was denied on this device'
        )
      }
      return stage(readAssets(await deps.launchLibrary({ multiple })))
    }
    return stage(readAssets(await deps.launchFiles({ multiple })))
  }

  /**
   * The bytes of one range, base64 for the wire.
   *
   * Each chunk is base64 on its own, so a page concatenates the decoded bytes and never the
   * strings: only the last chunk of a read ends on a partial group, and a reader that joined the
   * text would fold that padding into the middle of the file.
   */
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
      return { items: deps.registry.mint(await pickFrom(source, multiple)) }
    }
    if (verb === 'native.media.read') {
      const { handle, offset, length } = mediaReadParamsSchema.parse(params)
      const range = deps.registry.read(handle, offset, length)
      return { base64: readRange(range.uri, range.start, range.end), eof: range.eof }
    }
    const { handle } = mediaReleaseParamsSchema.parse(params)
    return { released: deps.registry.release(handle) }
  }
}

function readAssets(result: PickerResult): readonly PickedAsset[] {
  return result.canceled ? [] : (result.assets ?? [])
}
