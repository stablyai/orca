import {
  readPluginImageHeader,
  type PluginImageInfo
} from '../../../shared/plugins/images/plugin-image-format'
import {
  PLUGIN_IMAGE_RULES,
  pluginImageRuleError,
  type PluginCatalogImages,
  type PluginImageKind
} from '../../../shared/plugins/images/plugin-image-fields'
import { sha256Hex } from '../media/plugin-image-cache'

export type CatalogImage = NonNullable<PluginCatalogImages['cover']>

export type CatalogBlobReader = (path: string, maxBytes: number) => Promise<Buffer | null>

/** What one fetch learned about buffers its reader hands out again, so repeated extraction passes
 *  hash, scan and parse each one once. */
export type CatalogBufferMemo = {
  digests: WeakMap<Uint8Array, string>
  headers: WeakMap<Uint8Array, PluginImageInfo | string>
  manifests: WeakMap<Uint8Array, unknown>
}

export function createCatalogBufferMemo(): CatalogBufferMemo {
  return { digests: new WeakMap(), headers: new WeakMap(), manifests: new WeakMap() }
}

/** Checks one declared use against its declared hash, format, dimensions, and size. */
export function validateCatalogImage(
  bytes: Uint8Array,
  image: Pick<CatalogImage, 'sha256' | 'width' | 'height'>,
  kind: PluginImageKind,
  facts?: { info: PluginImageInfo | string; sha256: string }
): boolean {
  const info = facts?.info ?? readPluginImageHeader(bytes)
  return (
    typeof info !== 'string' &&
    bytes.byteLength <= PLUGIN_IMAGE_RULES[kind].maxBytes &&
    (facts?.sha256 ?? sha256Hex(bytes)) === image.sha256 &&
    info.width === image.width &&
    info.height === image.height &&
    pluginImageRuleError(kind, info, bytes.byteLength) === null
  )
}

/** sha256 of bytes, remembered per buffer when a pass-spanning memo is supplied. */
export function catalogImageDigest(bytes: Uint8Array, memo: CatalogBufferMemo | undefined): string {
  let digest = memo?.digests.get(bytes)
  if (digest === undefined) {
    digest = sha256Hex(bytes)
    memo?.digests.set(bytes, digest)
  }
  return digest
}

/** Image header of bytes, remembered per buffer like its digest. */
export function catalogImageHeader(
  bytes: Uint8Array,
  memo: CatalogBufferMemo | undefined
): PluginImageInfo | string {
  let info = memo?.headers.get(bytes)
  if (info === undefined) {
    info = readPluginImageHeader(bytes)
    memo?.headers.set(bytes, info)
  }
  return info
}
