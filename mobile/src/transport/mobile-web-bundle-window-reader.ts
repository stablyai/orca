import { decodeBase64Bytes } from './base64-byte-codec'
import { pairedE2EENativeCodec } from './paired-e2ee-native-codec'
import { mobileWebBundleChunkRead, mobileWebBundleRangeRead } from './mobile-web-bundle-operations'
import { decodeMobileWebBundleRange } from './mobile-web-bundle-range-decode'
import type { MobileWebBundleManifestReply } from './mobile-web-bundle-reply-schemas'
import type { RpcClient } from './rpc-client'
import { runRpcOperation } from './rpc-operation'
import type { SendRequestOptions } from './unvalidated-rpc-request-port'

/** What a chunk or range reply restates about the window it answers. */
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
  /** Decoded on demand, so a reply the fetch discards or refuses by its header is never inflated.
   *  `expected` is the slot length on the grid; a range inflates into at most one byte past it. */
  readonly bytes: (expected: number) => Uint8Array
}

/** One client, one grid and one read method, fixed for a whole fetch by the manifest reply. */
export type MobileWebBundleWindowReader = {
  readonly windowBytes: number
  read(
    window: {
      buildId: string
      path: string
      offset: number
    },
    options?: SendRequestOptions
  ): Promise<MobileWebBundleWindowReply>
}

/** Ranges when the host named a range grid, chunks otherwise: a host that predates the range
 *  method names none, and every bundle host serves chunks. */
export function mobileWebBundleWindowReader(
  client: RpcClient,
  opened: Pick<MobileWebBundleManifestReply, 'chunkBytes' | 'rangeBytes'>
): MobileWebBundleWindowReader {
  const { rangeBytes } = opened
  if (rangeBytes === undefined) {
    return {
      windowBytes: opened.chunkBytes,
      read: async (window, options) => {
        const { dataBase64, ...header } = await runRpcOperation(
          client,
          mobileWebBundleChunkRead,
          window,
          options
        )
        return { header, bytes: () => decodeBase64(dataBase64) }
      }
    }
  }
  return {
    windowBytes: rangeBytes,
    read: async (window, options) => {
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
    }
  }
}

/** Every host encodes with `Buffer#toString('base64')`, so the strict native decoder refuses nothing a
 *  host sends; `atob` is the fallback the pairing and E2EE paths already run on Hermes. */
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
