import { errorMessage } from '../../../../src/shared/error-message'
import { decodeBase64Bytes } from '../encryption/base64-byte-codec'
import { pairedE2EENativeCodec } from '../encryption/paired-e2ee-native-codec'
import {
  mobileWebBundleBrotliRangeRead,
  mobileWebBundleChunkRead,
  mobileWebBundleRangeRead
} from './mobile-web-bundle-operations'
import { decodeMobileWebBundleRange } from './mobile-web-bundle-range-decode'
import type {
  MobileWebBundleAssetRead,
  MobileWebBundleManifestReply
} from './mobile-web-bundle-reply-schemas'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import type { RpcClient } from '../rpc/rpc-client-contract'
import { runRpcOperation } from '../rpc/rpc-operation'
import type { SendRequestOptions } from '../rpc/unvalidated-rpc-request-port'

export type MobileWebBundleWindowHeader = {
  readonly buildId: string
  readonly path: string
  readonly offset: number
  readonly assetByteLength: number
  readonly sha256: string
  readonly eof: boolean
}

export type MobileWebBundleWindowReply = {
  readonly header: MobileWebBundleWindowHeader
  // Decode only after header/stop checks; inflate at most one byte past the expected slot length.
  readonly bytes: (expected: number) => Uint8Array
}

export type MobileWebBundleWindowReader = {
  readonly windowBytes: number
  /** What this reader moves for the asset: its brotli copy where it reads one, otherwise the asset itself. */
  readonly streamLength: (asset: MobileWebBundleAssetRead) => number
  read(
    window: {
      buildId: string
      path: string
      offset: number
    },
    options?: SendRequestOptions
  ): Promise<MobileWebBundleWindowReply>
  /** The asset's bytes from its reassembled stream, before the caller checks their hash. */
  readonly inflate: (
    asset: MobileWebBundleAssetRead,
    stream: Uint8Array<ArrayBuffer>
  ) => Promise<Uint8Array<ArrayBuffer>>
}

// Choose ranges only from the manifest’s grid; older hosts still serve chunks.
export function mobileWebBundleWindowReader(
  client: RpcClient,
  opened: Pick<MobileWebBundleManifestReply, 'chunkBytes' | 'rangeBytes' | 'manifest'>
): MobileWebBundleWindowReader {
  const { rangeBytes } = opened
  if (rangeBytes === undefined) {
    return {
      windowBytes: opened.chunkBytes,
      streamLength: (asset) => asset.byteLength,
      read: async (window, options) =>
        rawWindowReply(await runRpcOperation(client, mobileWebBundleChunkRead, window, options)),
      inflate: async (_asset, stream) => stream
    }
  }
  const native = pairedE2EENativeCodec()
  const brotliLengths = brotliStreamLengths(opened)
  return {
    windowBytes: rangeBytes,
    streamLength: (asset) => brotliLengths.get(asset.path) ?? asset.byteLength,
    read: async (window, options) => {
      if (brotliLengths.has(window.path)) {
        return rawWindowReply(
          await runRpcOperation(client, mobileWebBundleBrotliRangeRead, window, options)
        )
      }
      const { dataBase64, encoding, ...header } = await runRpcOperation(
        client,
        mobileWebBundleRangeRead,
        window,
        options
      )
      return {
        header,
        bytes: (expected) =>
          decodeMobileWebBundleRange(
            { path: header.path, offset: header.offset, encoding },
            decodeBase64(dataBase64),
            expected
          )
      }
    },
    inflate: async (asset, stream) =>
      native === null || !brotliLengths.has(asset.path)
        ? stream
        : inflateBrotli(native.brotliDecompress, asset, stream)
  }
}

// The assets a reader fetches as their brotli copy, by path, with that copy's length. Hermes has no brotli,
// so without the native codec, and on a host with no range grid, every asset stays on gzip ranges or chunks.
function brotliStreamLengths(
  opened: Pick<MobileWebBundleManifestReply, 'rangeBytes' | 'manifest'>
): ReadonlyMap<string, number> {
  if (opened.rangeBytes === undefined || pairedE2EENativeCodec() === null) {
    return new Map()
  }
  return new Map(
    opened.manifest.assets.flatMap((asset) =>
      asset.brotliByteLength !== undefined && asset.brotliByteLength < asset.byteLength
        ? [[asset.path, asset.brotliByteLength] as const]
        : []
    )
  )
}

// Bytes a whole download moves, in the unit of fetch progress: each brotli copy's length where one is read.
export function mobileWebBundleStreamBytes(
  opened: Pick<MobileWebBundleManifestReply, 'rangeBytes' | 'manifest'>
): number {
  const brotliLengths = brotliStreamLengths(opened)
  return opened.manifest.assets.reduce(
    (sum, asset) => sum + (brotliLengths.get(asset.path) ?? asset.byteLength),
    0
  )
}

// Chunks and brotli windows carry their bytes as they are.
function rawWindowReply({
  dataBase64,
  ...header
}: MobileWebBundleWindowHeader & { readonly dataBase64: string }): MobileWebBundleWindowReply {
  return { header, bytes: () => decodeBase64(dataBase64) }
}

// One byte past the asset bounds a bomb; the caller rejects any length but the asset's.
async function inflateBrotli(
  brotliDecompress: (input: Uint8Array, outputLimit: number) => Promise<Uint8Array<ArrayBuffer>>,
  asset: MobileWebBundleAssetRead,
  stream: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await brotliDecompress(stream, asset.byteLength + 1)
  } catch (error) {
    throw new MobileWebBundleFetchError(
      'range-undecodable',
      `bundle asset ${asset.path} is not valid brotli: ${errorMessage(error)}`
    )
  }
}

// Canonical host base64 works with strict native decoding; retain the Hermes atob fallback.
function decodeBase64(value: string): Uint8Array {
  const native = pairedE2EENativeCodec()
  if (!native) {
    return decodeBase64Bytes(value)
  }
  const bytes = native.decodeBase64(value)
  if (!bytes) {
    throw new Error('bundle window is not canonical base64')
  }
  return bytes
}
