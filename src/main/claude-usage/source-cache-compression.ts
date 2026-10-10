import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const MIN_COMPRESSED_BYTES = 64 * 1024
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024
const ZLIB_CHUNK_BYTES = 256 * 1024

export async function compressClaudeUsageSourceText(text: string): Promise<string | Buffer> {
  const bytes = Buffer.byteLength(text)
  if (bytes < MIN_COMPRESSED_BYTES || bytes > MAX_COMPRESSED_BYTES) {
    return text
  }
  const compressed = await gzipAsync(text, { level: 1, chunkSize: ZLIB_CHUNK_BYTES })
  return compressed.byteLength < bytes ? compressed : text
}

export async function decodeClaudeUsageSourceText(saved: string | Buffer): Promise<string> {
  if (typeof saved === 'string') {
    return saved
  }
  if (saved[0] !== 0x1f || saved[1] !== 0x8b) {
    return saved.toString('utf8')
  }
  if (saved.length < 18) {
    throw new Error('Saved Claude usage gzip stream is truncated.')
  }
  const bytes = saved.readUInt32LE(saved.length - 4)
  if (bytes < MIN_COMPRESSED_BYTES || bytes > MAX_COMPRESSED_BYTES) {
    throw new Error('Saved Claude usage gzip length is invalid.')
  }
  const decoded = await gunzipAsync(saved, {
    maxOutputLength: bytes,
    chunkSize: ZLIB_CHUNK_BYTES
  })
  if (decoded.byteLength !== bytes) {
    throw new Error('Saved Claude usage compression length is invalid.')
  }
  return decoded.toString('utf8')
}
