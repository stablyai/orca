export const USTAR_BLOCK_BYTES = 512

export type UstarEntry = {
  path: string
  size: number
  mode: number
  type: 'file' | 'directory'
}

/** `errorPrefix` keeps each caller's failure codes (`<prefix>-tar-path-limit`). */
function writeField(
  header: Buffer,
  offset: number,
  length: number,
  value: string,
  errorPrefix: string
): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) {
    throw new Error(`${errorPrefix}-tar-path-limit`)
  }
  bytes.copy(header, offset)
}

function writeOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
  errorPrefix: string
): void {
  const encoded = value.toString(8).padStart(length - 1, '0')
  if (encoded.length > length - 1) {
    throw new Error(`${errorPrefix}-tar-number-limit`)
  }
  writeField(header, offset, length, `${encoded}\0`, errorPrefix)
}

function splitTarPath(path: string, errorPrefix: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, 'utf8') <= 100) {
    return { name: path, prefix: '' }
  }
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix }
    }
  }
  throw new Error(`${errorPrefix}-tar-path-limit`)
}

/** A ustar header with root ownership and a zero mtime, so equal inputs archive identically. */
export function buildUstarEntryHeader(entry: UstarEntry, errorPrefix: string): Buffer {
  const header = Buffer.alloc(USTAR_BLOCK_BYTES)
  const { name, prefix } = splitTarPath(entry.path, errorPrefix)
  writeField(header, 0, 100, name, errorPrefix)
  writeOctal(header, 100, 8, entry.mode & 0o7777, errorPrefix)
  writeOctal(header, 108, 8, 0, errorPrefix)
  writeOctal(header, 116, 8, 0, errorPrefix)
  writeOctal(header, 124, 12, entry.type === 'directory' ? 0 : entry.size, errorPrefix)
  writeOctal(header, 136, 12, 0, errorPrefix)
  header.fill(0x20, 148, 156)
  header[156] = (entry.type === 'directory' ? '5' : '0').charCodeAt(0)
  writeField(header, 257, 6, 'ustar', errorPrefix)
  writeField(header, 263, 2, '00', errorPrefix)
  writeField(header, 345, 155, prefix, errorPrefix)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const checksumText = checksum.toString(8).padStart(6, '0')
  writeField(header, 148, 8, `${checksumText}\0 `, errorPrefix)
  return header
}

/** Zero bytes that round `size` up to a whole block. */
export function ustarPaddingBytes(size: number): number {
  return (USTAR_BLOCK_BYTES - (size % USTAR_BLOCK_BYTES)) % USTAR_BLOCK_BYTES
}
