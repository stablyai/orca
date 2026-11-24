import * as z from 'zod'
import { MOBILE_WEB_CATALOG_MAX_RAW_BYTES } from '../../../src/shared/mobile-web-bundle/catalog-reply-size'
import { SHA256_PATTERN } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { DEVICE_STORE_MAX_VALUE_LENGTH } from '../device-store/device-store-value-codec'
import { decodeCanonicalBase64Bytes } from '../transport/encryption/base64-byte-codec'

const storedCatalogSchema = z.object({
  v: z.literal(1),
  sha256: z.string().regex(SHA256_PATTERN),
  catalog: z.record(z.string(), z.unknown())
})

// Compact JSON adds 94 bytes for the v1 fields and 64-character SHA.
const MAX_V1_BYTES = MOBILE_WEB_CATALOG_MAX_RAW_BYTES + 94

export async function decodeStoredPageCatalog(raw: string) {
  if (raw.length > DEVICE_STORE_MAX_VALUE_LENGTH) {
    return null
  }
  const compressed = decodeCanonicalBase64Bytes(raw)
  if (!compressed || compressed.length < 18 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    return null
  }
  const hint = new DataView(
    compressed.buffer,
    compressed.byteOffset,
    compressed.byteLength
  ).getUint32(compressed.length - 4, true)
  if (hint === 0 || hint > MAX_V1_BYTES) {
    return null
  }
  try {
    const { inflateCatalogGzip } = await import('./catalog-gzip-member')
    const bytes = inflateCatalogGzip(compressed, hint, MAX_V1_BYTES)
    const json: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    )
    const parsed = storedCatalogSchema.safeParse(json)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
