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
} from '../filesystem/durable-file-write'
import {
  protectedUsageCacheJson,
  readProtectedUsageCacheJson
} from '../usage/cache/usage-cache-protected-json'
import {
  writeUsageSourceCacheData,
  type UsageSourceCacheRef
} from '../usage/cache/usage-source-cache-file'

const MIN_COMPRESSED_BYTES = 64 * 1024
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024

/** Keep magic, declared length and body on the same opened generation. */
async function* decodedSourceText(path: string): AsyncGenerator<string> {
  const handle = await open(path, 'r')
  try {
    const magic = Buffer.alloc(2)
    await handle.read(magic, 0, 2, 0)
    const gzip = magic[0] === 0x1f && magic[1] === 0x8b
    let expected = 0
    if (gzip) {
      const { size } = await handle.stat()
      if (size < 18) {
        throw new Error('Saved Claude usage gzip stream is truncated.')
      }
      const footer = Buffer.alloc(4)
      await handle.read(footer, 0, 4, size - 4)
      expected = footer.readUInt32LE(0)
      if (expected < MIN_COMPRESSED_BYTES || expected > MAX_COMPRESSED_BYTES) {
        throw new Error('Saved Claude usage gzip length is invalid.')
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
        if (gzip && (bytes > expected || bytes > MAX_COMPRESSED_BYTES)) {
          throw new Error('Saved Claude usage compression length is invalid.')
        }
        yield decoder.write(chunk)
      }
      if (gzip && bytes !== expected) {
        throw new Error('Saved Claude usage compression length is invalid.')
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

export async function readClaudeUsageJson<T extends { usageIntegrity?: unknown }>(
  path: string,
  domain: string,
  strict = true
): Promise<{ parsed: T; verified: boolean }> {
  return readProtectedUsageCacheJson<T>(decodedSourceText(path), domain, strict)
}

export async function writeClaudeUsageJson(
  ref: UsageSourceCacheRef,
  value: unknown,
  domain: string,
  sealed: boolean
): Promise<void> {
  const material = protectedUsageCacheJson(value, domain, sealed)
  if (material.bytes < MIN_COMPRESSED_BYTES || material.bytes > MAX_COMPRESSED_BYTES) {
    await writeUsageSourceCacheData(ref, material.encode())
    return
  }
  await mkdir(dirname(ref.path), { recursive: true })
  await removeStaleDurableWriteTempFiles(ref.path)
  const candidate = durableWriteTempPath(ref.path, threadId > 0 ? String(threadId) : undefined)
  async function* gzipChunks(): AsyncGenerator<Buffer> {
    const input = Readable.from(material.encode())
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
    if ((await stat(candidate)).size < material.bytes) {
      await renameDurable(candidate, ref.path)
      published = true
    } else {
      await writeUsageSourceCacheData(ref, material.encode())
    }
  } finally {
    if (!published) {
      await rm(candidate, { force: true }).catch(() => {})
    }
  }
}
