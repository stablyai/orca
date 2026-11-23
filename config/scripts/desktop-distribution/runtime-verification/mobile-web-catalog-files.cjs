const { createHash } = require('node:crypto')
const { gzipSync, gunzipSync } = require('node:zlib')
const {
  MOBILE_WEB_CATALOG_MAX_RAW_BYTES,
  MOBILE_WEB_CATALOG_MAX_RESULT_BYTES,
  gzipCatalogResult,
  identityCatalogResult
} = require('../../../../src/shared/mobile-web-bundle/catalog-reply-size.ts')

function encodeCatalogGzip(raw) {
  const gzip = gzipSync(raw, { level: 9 })
  Buffer.from('1f8b08000000000002ff', 'hex').copy(gzip)
  return gzip
}

function assertSelectedResultSize(entry, file, result) {
  if (
    file.byteLength > MOBILE_WEB_CATALOG_MAX_RESULT_BYTES ||
    Buffer.byteLength(JSON.stringify(result)) > MOBILE_WEB_CATALOG_MAX_RESULT_BYTES
  ) {
    throw new Error(`selected ${entry.locale} catalog exceeds the 393,216-byte delivery budget`)
  }
}

function selectMobileWebCatalogFile(entry, catalog) {
  const identity = identityCatalogResult(entry, catalog)
  if (entry.byteLength > MOBILE_WEB_CATALOG_MAX_RAW_BYTES) {
    throw new Error(`${entry.locale} catalog exceeds the decoded byte limit`)
  }
  if (Buffer.byteLength(JSON.stringify(identity)) <= MOBILE_WEB_CATALOG_MAX_RESULT_BYTES) {
    assertSelectedResultSize(entry, entry, identity)
    return entry
  }
  const bytes = encodeCatalogGzip(entry.bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const gzip = {
    path: `catalogs/${sha256}.json.gz`,
    byteLength: bytes.length,
    sha256,
    rawByteLength: entry.byteLength,
    rawSha256: entry.sha256,
    bytes
  }
  assertSelectedResultSize(entry, gzip, gzipCatalogResult(entry, gzip, bytes.toString('base64')))
  return { ...entry, gzip }
}

function verifyMobileWebCatalogFile(entry, read) {
  if (entry.byteLength > MOBILE_WEB_CATALOG_MAX_RAW_BYTES) {
    throw new Error(`${entry.locale} catalog exceeds the decoded byte limit`)
  }
  const raw = read(entry.path)
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
  const catalog = JSON.parse(text)
  if (!catalog || Array.isArray(catalog) || typeof catalog !== 'object') {
    throw new Error(`${entry.path} is not a catalog object`)
  }
  const selected = selectMobileWebCatalogFile({ ...entry, gzip: undefined, bytes: raw }, catalog)
  if (Boolean(selected.gzip) !== Boolean(entry.gzip)) {
    throw new Error(`${entry.locale} catalog's declared encoding disagrees with selection`)
  }
  if (entry.gzip) {
    const bytes = read(entry.gzip.path)
    if (
      !bytes.equals(selected.gzip.bytes) ||
      !gunzipSync(bytes, { maxOutputLength: entry.byteLength + 1 }).equals(raw)
    ) {
      throw new Error(`${entry.gzip.path} does not match the canonical gzip of ${entry.path}`)
    }
  }
}

module.exports = { selectMobileWebCatalogFile, verifyMobileWebCatalogFile }
