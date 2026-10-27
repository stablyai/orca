import { decodeBase64Bytes } from './base64-byte-codec'
import { pairedE2EENativeCodec } from './paired-e2ee-native-codec'
import { mobileWebBundleChunkRead, mobileWebBundleRangeRead } from './mobile-web-bundle-operations'
import { decodeMobileWebBundleRange } from './mobile-web-bundle-range-decode'
import type { MobileWebBundleManifestReply } from './mobile-web-bundle-reply-schemas'
import type { RpcClient } from './rpc-client'
import { runRpcOperation } from './rpc-operation'
import type { SendRequestOptions } from './unvalidated-rpc-request-port'

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
  read(
    window: {
      buildId: string
      path: string
      offset: number
    },
    options?: SendRequestOptions
  ): Promise<MobileWebBundleWindowReply>
}

// Choose ranges only from the manifest’s grid; older hosts still serve chunks.
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
