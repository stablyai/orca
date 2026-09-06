import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import { gunzipSync } from 'fflate'
import {
  MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES,
  MobileWebPackageAssetChunkSchema,
  MobileWebPackageGzipAssetChunkSchema
} from '../../../src/shared/mobile-web/package-rpc-contract'

export function decodeRawMobileWebPackageChunk(
  result: unknown,
  buildId: string,
  path: string,
  offset: number,
  expectedLength: number,
  assetByteLength: number
): Uint8Array | null {
  const chunk = MobileWebPackageAssetChunkSchema.safeParse(result)
  if (
    !chunk.success ||
    chunk.data.buildId !== buildId ||
    chunk.data.path !== path ||
    chunk.data.offset !== offset ||
    chunk.data.byteLength !== expectedLength ||
    chunk.data.eof !== (offset + expectedLength === assetByteLength)
  ) {
    return null
  }
  const bytes = decodeCanonicalBase64(chunk.data.dataBase64)
  return bytes?.byteLength === expectedLength && sha256Hex(bytes) === chunk.data.sha256
    ? bytes
    : null
}

export function decodeGzipMobileWebPackageChunk(
  result: unknown,
  buildId: string,
  path: string,
  offset: number,
  expectedLength: number,
  assetByteLength: number
): Uint8Array | null {
  const chunk = MobileWebPackageGzipAssetChunkSchema.safeParse(result)
  if (
    !chunk.success ||
    chunk.data.encoding !== 'gzip' ||
    chunk.data.buildId !== buildId ||
    chunk.data.path !== path ||
    chunk.data.offset !== offset ||
    chunk.data.sourceByteLength !== expectedLength ||
    chunk.data.eof !== (offset + expectedLength === assetByteLength)
  ) {
    return null
  }
  if (expectedLength > MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES) {
    return null
  }
  const compressed = decodeCanonicalBase64(chunk.data.dataBase64)
  if (
    !compressed ||
    compressed.byteLength !== chunk.data.byteLength ||
    sha256Hex(compressed) !== chunk.data.sha256
  ) {
    return null
  }
  try {
    // Reserve one sentinel byte so expansion beyond the advertised size is rejected without an
    // attacker-controlled allocation.
    const bytes = gunzipSync(compressed, { out: new Uint8Array(expectedLength + 1) })
    return bytes.byteLength === expectedLength ? bytes : null
  } catch {
    return null
  }
}

function decodeCanonicalBase64(value: string): Uint8Array | null {
  const bytes = Buffer.from(value, 'base64')
  return bytes.toString('base64') === value ? bytes : null
}

function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}
