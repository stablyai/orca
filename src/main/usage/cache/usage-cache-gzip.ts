import { open, mkdir, rm, stat } from 'node:fs/promises'
import { threadId } from 'node:worker_threads'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createGzip, createGunzip } from 'node:zlib'
import {
  durableWriteTempPath,
  renameDurable,
  removeStaleDurableWriteTempFiles,
  writeTempFileDurable
} from '../../filesystem/durable-file-write'

export const MIN_GZIP_PLAIN_BYTES = 64 * 1024
// Gzip records the plain length modulo 2^32, so stay well below it.
export const MAX_GZIP_PLAIN_BYTES = 1024 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024

/** Plain or gzip cache text; keep magic, declared length and body on the same opened generation. */
export async function* decodedUsageCacheText(path: string): AsyncGenerator<string> {
  const handle = await open(path, 'r')
  try {
    const magic = Buffer.alloc(2)
    await handle.read(magic, 0, 2, 0)
    const gzip = magic[0] === 0x1f && magic[1] === 0x8b
    let expected = 0
    if (gzip) {
      const { size } = await handle.stat()
      if (size < 18) {
        throw new Error('Saved usage cache gzip stream is truncated.')
      }
      const footer = Buffer.alloc(4)
      await handle.read(footer, 0, 4, size - 4)
      expected = footer.readUInt32LE(0)
      if (expected < MIN_GZIP_PLAIN_BYTES || expected > MAX_GZIP_PLAIN_BYTES) {
        throw new Error('Saved usage cache gzip length is invalid.')
      }
    }
    const input = handle.createReadStream({
      start: 0,
      autoClose: false,
      highWaterMark: CHUNK_BYTES
    })
    const expanded = gzip ? input.pipe(createGunzip({ chunkSize: CHUNK_BYTES })) : input
    input.on('error', (error) => expanded.destroy(error))
    const decoder = new StringDecoder('utf8')
    let bytes = 0
    try {
      for await (const chunk of expanded) {
        bytes += chunk.byteLength
        if (gzip && (bytes > expected || bytes > MAX_GZIP_PLAIN_BYTES)) {
          throw new Error('Saved usage cache compression length is invalid.')
        }
        yield decoder.write(chunk)
      }
      if (gzip && bytes !== expected) {
        throw new Error('Saved usage cache compression length is invalid.')
      }
      const remaining = decoder.end()
      if (remaining) {
        yield remaining
      }
    } finally {
      input.destroy()
      expanded.destroy()
    }
  } finally {
    await handle.close()
  }
}

class PlainSizeLimitError extends Error {}

/** Publish gzip only when its plain size is readable back and it saves space; false means write plain. */
export async function publishGzipUsageCache(
  path: string,
  text: Iterable<string>,
  maxPlainBytes = MAX_GZIP_PLAIN_BYTES
): Promise<boolean> {
  const chunks = text[Symbol.iterator]()
  const head: string[] = []
  let plainBytes = 0
  // Small caches stay plain without a throwaway compressed write.
  while (plainBytes < MIN_GZIP_PLAIN_BYTES) {
    const next = chunks.next()
    if (next.done) {
      return false
    }
    head.push(next.value)
    plainBytes += Buffer.byteLength(next.value)
  }
  function* counted(): Generator<string> {
    yield* head
    for (let next = chunks.next(); !next.done; next = chunks.next()) {
      plainBytes += Buffer.byteLength(next.value)
      if (plainBytes > maxPlainBytes) {
        throw new PlainSizeLimitError()
      }
      yield next.value
    }
  }
  await mkdir(dirname(path), { recursive: true })
  await removeStaleDurableWriteTempFiles(path)
  const candidate = durableWriteTempPath(path, threadId > 0 ? String(threadId) : undefined)
  async function* gzipChunks(): AsyncGenerator<Buffer> {
    const input = Readable.from(counted())
    const compressed = input.pipe(createGzip({ level: 1, chunkSize: CHUNK_BYTES }))
    input.on('error', (error) => compressed.destroy(error))
    try {
      yield* compressed
    } finally {
      input.destroy()
      compressed.destroy()
    }
  }
  let published = false
  try {
    await writeTempFileDurable(candidate, gzipChunks(), 0o600)
    if ((await stat(candidate)).size < plainBytes) {
      await renameDurable(candidate, path)
      published = true
    }
    return published
  } catch (error) {
    if (error instanceof PlainSizeLimitError) {
      return false
    }
    throw error
  } finally {
    if (!published) {
      await rm(candidate, { force: true }).catch(() => {})
    }
  }
}
