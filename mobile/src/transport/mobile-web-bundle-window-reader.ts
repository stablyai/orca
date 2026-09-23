import { mobileWebBundleChunkRead, mobileWebBundleRangeRead } from './mobile-web-bundle-operations'
import { decodeMobileWebBundleRange } from './mobile-web-bundle-range-decode'
import type { MobileWebBundleManifestReply } from './mobile-web-bundle-reply-schemas'
import type { RpcClient } from './rpc-client'
import { runRpcOperation } from './rpc-operation'

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
  /** Decoded on demand, so a reply the fetch discards or refuses by its header is never inflated. */
  readonly bytes: () => Uint8Array
}

/** One grid and one read method, fixed for a whole fetch by what the manifest reply named. */
export type MobileWebBundleWindowReader = {
  readonly windowBytes: number
  read(
    client: RpcClient,
    window: { buildId: string; path: string; offset: number }
  ): Promise<MobileWebBundleWindowReply>
}

/** Ranges when the host named a range grid, chunks otherwise: a host that predates the range
 *  method names none, and every bundle host serves chunks. */
export function mobileWebBundleWindowReader(
  opened: Pick<MobileWebBundleManifestReply, 'chunkBytes' | 'rangeBytes'>
): MobileWebBundleWindowReader {
  const { rangeBytes } = opened
  if (rangeBytes === undefined) {
    return {
      windowBytes: opened.chunkBytes,
      read: async (client, window) => {
        const { dataBase64, ...header } = await runRpcOperation(
          client,
          mobileWebBundleChunkRead,
          window
        )
        return { header, bytes: () => decodeBase64(dataBase64) }
      }
    }
  }
  return {
    windowBytes: rangeBytes,
    read: async (client, window) => {
      const { dataBase64, encoding, ...header } = await runRpcOperation(
        client,
        mobileWebBundleRangeRead,
        window
      )
      const expected = Math.max(0, Math.min(rangeBytes, header.assetByteLength - header.offset))
      return {
        header,
        bytes: () =>
          decodeMobileWebBundleRange(
            { path: header.path, offset: header.offset, encoding },
            decodeBase64(dataBase64),
            expected
          )
      }
    }
  }
}

/** Metro ships no Buffer; `atob` is the decoder the pairing and E2EE paths already run on Hermes. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
