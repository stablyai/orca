import {
  MOBILE_WEB_CATALOG_MAX_RAW_BYTES,
  MOBILE_WEB_CATALOG_MAX_RESULT_BYTES
} from '../../../src/shared/mobile-web-bundle/catalog-reply-size'
import { bytesToHex, sha256 } from '../../../src/shared/hashing/sha256'
import type { MobileWebBundleGzipCatalogResult } from '../../../src/shared/mobile-web-bundle/locale-catalog-contract'
import { utf8ByteLength } from '../mobile-web-shell/bridge/protocol/bridge-caps'
import { decodeCanonicalBase64Bytes } from '../transport/encryption/base64-byte-codec'
import type { inflateCatalogGzip } from './catalog-gzip-member'
import type { LocaleCatalog } from './bundled-locale-catalogs'

const CATALOG_GZIP_HEADER = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]

export function decodePageCatalogGzip(
  reply: MobileWebBundleGzipCatalogResult,
  inflate: typeof inflateCatalogGzip
): LocaleCatalog {
  if (
    reply.dataBase64.length !== Math.ceil(reply.gzipByteLength / 3) * 4 ||
    utf8ByteLength(JSON.stringify(reply)) > MOBILE_WEB_CATALOG_MAX_RESULT_BYTES
  ) {
    throw new Error('oversized catalog gzip result')
  }
  const input = decodeCanonicalBase64Bytes(reply.dataBase64)
  if (
    !input ||
    input.length !== reply.gzipByteLength ||
    CATALOG_GZIP_HEADER.some((byte, index) => input[index] !== byte) ||
    bytesToHex(sha256(input)) !== reply.gzipSha256
  ) {
    throw new Error('invalid compressed catalog bytes')
  }
  const output = inflate(input, reply.byteLength, MOBILE_WEB_CATALOG_MAX_RAW_BYTES)
  if (bytesToHex(sha256(output)) !== reply.sha256) {
    throw new Error('invalid decoded catalog digest')
  }
  const catalog: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output)
  )
  if (catalog === null || Array.isArray(catalog) || typeof catalog !== 'object') {
    throw new Error('invalid locale catalog')
  }
  return { ...catalog }
}
