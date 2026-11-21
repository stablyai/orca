import { strFromU8 } from 'fflate'
import * as z from 'zod'
import { bytesToHex } from '../../../src/shared/hashing/orca-hook-content-hash'
import { sha256 } from '../../../src/shared/hashing/sha256'
import {
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_MAX_BYTES,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES,
  MobileWebBundleLocaleCatalogRangeResultSchema,
  MobileWebBundleLocaleCatalogResultSchema
} from '../../../src/shared/mobile-web-bundle/locale-catalog-contract'
import { decodeBase64Bytes } from '../transport/encryption/base64-byte-codec'
import { decodeMobileWebBundleRange } from '../transport/web-bundle/mobile-web-bundle-range-decode'
import { assertWindowFillsItsSlot } from '../transport/web-bundle/mobile-web-bundle-window-checks'
import type { LocaleCatalog } from './bundled-locale-catalogs'

// Loose like every phone reader. The length cap bounds what the page allocates; an encoding this build
// lacks reaches the decoder's own refusal.
export const LocaleCatalogRangeReplySchema = MobileWebBundleLocaleCatalogRangeResultSchema.extend({
  byteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_LOCALE_CATALOG_MAX_BYTES),
  encoding: z.string().min(1).max(32)
}).loose()

type LocaleCatalogRangeReply = z.output<typeof LocaleCatalogRangeReplySchema>

/** The host's catalog hash, and the catalog unless the copy the page named already has that hash. */
export type LocaleCatalogAnswer = {
  readonly sha256: string
  readonly catalog: LocaleCatalog | null
}

const catalogSchema = MobileWebBundleLocaleCatalogResultSchema.shape.catalog.unwrap()

// Windows in order on the grid the first one sets, then the whole against the hash every window named.
export async function readLocaleCatalogInRanges(
  locale: string,
  readWindow: (offset: number) => Promise<LocaleCatalogRangeReply>
): Promise<LocaleCatalogAnswer> {
  const first = await readWindow(0)
  if (first.dataBase64 === null) {
    return { sha256: first.sha256, catalog: null }
  }
  const stream = { path: `${locale} catalog`, byteLength: first.byteLength }
  const whole = new Uint8Array(first.byteLength)
  let windowBytes = MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES
  let reply = first
  let offset = 0
  for (;;) {
    const { sha256: named, byteLength, dataBase64 } = reply
    if (reply.locale !== locale || reply.offset !== offset || dataBase64 === null) {
      throw new Error(`[i18n] the ${locale} catalog window at ${offset} answered another read`)
    }
    if (named !== first.sha256 || byteLength !== first.byteLength) {
      throw new Error(`[i18n] the ${locale} catalog changed while it was read`)
    }
    const wire = decodeBase64Bytes(dataBase64)
    const range = { path: stream.path, offset, encoding: reply.encoding }
    const bytes = decodeMobileWebBundleRange(
      range,
      wire,
      Math.min(windowBytes, byteLength - offset)
    )
    // A host may cut finer than the contract's ceiling, as asset hosts may shrink their grid.
    if (offset === 0 && !reply.eof) {
      windowBytes = Math.min(Math.max(1, bytes.byteLength), windowBytes)
    }
    assertWindowFillsItsSlot(stream, offset, bytes.byteLength, reply.eof, windowBytes)
    whole.set(bytes, offset)
    offset += bytes.byteLength
    if (reply.eof) {
      break
    }
    reply = await readWindow(offset)
  }
  const hashed = bytesToHex(sha256(whole))
  if (hashed !== first.sha256) {
    throw new Error(`[i18n] the ${locale} catalog hashed ${hashed}, not ${first.sha256}`)
  }
  return { sha256: first.sha256, catalog: parseCatalog(locale, whole) }
}

function parseCatalog(locale: string, bytes: Uint8Array): LocaleCatalog {
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(bytes))
  } catch {
    parsed = undefined
  }
  const catalog = catalogSchema.safeParse(parsed)
  if (!catalog.success) {
    throw new Error(`[i18n] the ${locale} catalog is not a catalog object`)
  }
  return catalog.data
}
