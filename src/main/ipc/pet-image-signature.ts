/** Bytes needed to recognise every format the pet importer accepts. */
export const SIGNATURE_BYTES = 64

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.from([0xff, 0xd8, 0xff])

/** Identifies an image from its own bytes.
 *
 *  The importer used to trust the file extension alone, which says nothing
 *  about what a file contains — a renamed executable passed as a pet. This is
 *  the second opinion: what the bytes actually are. */
export function sniffImageMime(bytes: Buffer | Uint8Array): string | null {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.byteLength === 0) {
    return null
  }
  if (buffer.subarray(0, PNG.length).equals(PNG)) {
    return 'image/png'
  }
  if (buffer.subarray(0, JPEG.length).equals(JPEG)) {
    return 'image/jpeg'
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'image/gif'
  }
  // Why: RIFF alone is not enough — WAV and AVI share the container.
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (looksLikeSvg(buffer)) {
    return 'image/svg+xml'
  }
  return null
}

/** True when the bytes agree with the format the filename claimed. */
export function signatureMatchesExtension(
  bytes: Buffer | Uint8Array,
  declaredMime: string
): boolean {
  const sniffed = sniffImageMime(bytes)
  if (!sniffed) {
    return false
  }
  // Why: an APNG is a PNG with an extra chunk, so they share a signature and
  // the extension is the only thing that distinguishes them.
  const declared = declaredMime === 'image/apng' ? 'image/png' : declaredMime
  return sniffed === declared
}

function looksLikeSvg(buffer: Buffer): boolean {
  // SVG is text, so there is no magic number — only a shape. Skip the BOM and
  // leading whitespace, then require a tag that starts a document.
  let start = 0
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    start = 3
  }
  const head = buffer
    .subarray(start, start + SIGNATURE_BYTES)
    .toString('utf8')
    .trimStart()
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!DOCTYPE svg')
}
