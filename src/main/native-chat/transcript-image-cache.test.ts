import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import { supportsPosixFileModes } from '../daemon/daemon-private-file-modes'
import {
  hydrateNativeChatImageRefs,
  NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES,
  NATIVE_CHAT_IMAGE_CACHE_PRUNE_INTERVAL_MS,
  NATIVE_CHAT_IMAGE_CACHE_RETENTION_MS,
  pruneNativeChatImageCache,
  pruneNativeChatImageCacheIfDue
} from './transcript-image-cache'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, linkSync: vi.fn(actual.linkSync) }
})

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BLUE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNgYPj/HwADAgH/FAeIXAAAAABJRU5ErkJggg=='
const DATA_URL = `data:image/png;base64,${PNG_1PX}`
const cacheDirs: string[] = []

afterAll(() => {
  for (const dir of cacheDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function messageWithUrl(url: string): NativeChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    blocks: [
      { type: 'text', text: 'here' },
      { type: 'image-ref', url }
    ],
    timestamp: null,
    source: 'transcript'
  }
}

function freshCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nnc-img-'))
  cacheDirs.push(dir)
  return dir
}

function pngWithComment(comment: string, source = PNG_1PX): string {
  const image = Buffer.from(source, 'base64')
  const chunk = Buffer.from(`tEXtComment\0${comment}${'padding'.repeat(10)}`)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(chunk.length - 4)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(chunk))
  return Buffer.concat([
    image.subarray(0, -12),
    length,
    chunk,
    checksum,
    image.subarray(-12)
  ]).toString('base64')
}

describe('hydrateNativeChatImageRefs', () => {
  it('keeps distinct screenshots separate when their message IDs, lengths and suffixes match', () => {
    const cacheDir = freshCacheDir()
    const firstImage = pngWithComment('screenshot')
    const secondImage = pngWithComment('screenshot', PNG_BLUE)
    expect(firstImage.length).toBe(secondImage.length)
    expect(firstImage.slice(-64)).toBe(secondImage.slice(-64))

    const [first] = hydrateNativeChatImageRefs(
      [messageWithUrl(`data:image/png;base64,${firstImage}`)],
      { cacheDir }
    )
    const [second] = hydrateNativeChatImageRefs(
      [messageWithUrl(`data:image/png;base64,${secondImage}`)],
      { cacheDir }
    )
    const a = first?.blocks[1]
    const b = second?.blocks[1]
    if (a?.type !== 'image-ref' || !a.path || b?.type !== 'image-ref' || !b.path) {
      throw new Error('expected cached screenshot paths')
    }
    expect(readFileSync(b.path).toString('base64')).toBe(secondImage)
    expect(b.path).not.toBe(a.path)
  })

  it('persists data: bytes to the cache and rewrites to a path ref', async () => {
    const cacheDir = freshCacheDir()
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    const ref = hydrated.blocks[1]
    expect(ref.type).toBe('image-ref')
    if (ref.type !== 'image-ref') {
      return
    }
    expect(ref.url).toBeUndefined()
    expect(ref.path).toMatch(/\.png$/)
    expect(ref.path!.startsWith(cacheDir)).toBe(true)
    expect(readFileSync(ref.path!).toString('base64')).toBe(PNG_1PX)
  })

  it('writes cache files privately on posix', async () => {
    const cacheDir = freshCacheDir()
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    const ref = hydrated.blocks[1]
    if (ref.type !== 'image-ref' || !ref.path) {
      throw new Error('expected a hydrated path ref')
    }
    expect(existsSync(ref.path)).toBe(true)
    if (supportsPosixFileModes()) {
      expect(statSync(ref.path).mode & 0o777).toBe(0o600)
    }
  })

  it('never rewrites an existing cache entry (write-once by content hash)', async () => {
    const cacheDir = freshCacheDir()
    const digest = createHash('sha256').update(Buffer.from(PNG_1PX, 'base64')).digest('hex')
    const cached = join(cacheDir, `${digest}.png`)
    writeFileSync(cached, 'stale-bytes')
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    const ref = hydrated.blocks[1]
    if (ref.type !== 'image-ref') {
      throw new Error('expected an image-ref')
    }
    expect(ref.path).toBe(cached)
    expect(readFileSync(cached, 'utf8')).toBe('stale-bytes')
  })

  it('publishes the entry whole and leaves no temp file behind', async () => {
    const cacheDir = freshCacheDir()
    await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    expect(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('rewrites a remembered entry whose cache file was removed', async () => {
    const cacheDir = freshCacheDir()
    const message = messageWithUrl(DATA_URL)
    const [first] = await hydrateNativeChatImageRefs([message], { cacheDir })
    const ref = first.blocks[1]
    if (ref.type !== 'image-ref' || !ref.path) {
      throw new Error('expected a hydrated path ref')
    }
    rmSync(ref.path)
    const [second] = await hydrateNativeChatImageRefs([message], { cacheDir })
    expect(second.blocks[1]).toEqual(ref)
    expect(readFileSync(ref.path).toString('base64')).toBe(PNG_1PX)
  })

  it('does not reuse a memoized path when the same block gets different bytes', () => {
    const cacheDir = freshCacheDir()
    const message = messageWithUrl(DATA_URL)
    const [first] = hydrateNativeChatImageRefs([message], { cacheDir })
    const image = message.blocks[1]
    if (image?.type !== 'image-ref') {
      throw new Error('expected a source image')
    }
    const updated = pngWithComment('updated')
    image.url = `data:image/png;base64,${updated}`
    const [second] = hydrateNativeChatImageRefs([message], { cacheDir })
    const path = second?.blocks[1]
    if (path?.type !== 'image-ref' || !path.path) {
      throw new Error('expected a new cached image')
    }
    expect(path).not.toEqual(first?.blocks[1])
    expect(readFileSync(path.path).toString('base64')).toBe(updated)
  })

  it('falls back to rename where the volume has no hard links', async () => {
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    const cacheDir = freshCacheDir()
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    const ref = hydrated.blocks[1]
    if (ref.type !== 'image-ref' || !ref.path) {
      throw new Error('expected a hydrated path ref despite the link failure')
    }
    expect(readFileSync(ref.path).toString('base64')).toBe(PNG_1PX)
    expect(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves refs inline instead of failing when the cache dir cannot be created', async () => {
    const blocker = join(freshCacheDir(), 'not-a-dir')
    writeFileSync(blocker, 'x')
    const message = messageWithUrl(DATA_URL)
    const hydrated = await hydrateNativeChatImageRefs([message], {
      cacheDir: join(blocker, 'native-chat-images')
    })
    expect(hydrated).toEqual([message])
  })

  it('passes remote urls and existing paths through untouched', async () => {
    const cacheDir = freshCacheDir()
    const remote = messageWithUrl('https://x.test/shot.png')
    const local: NativeChatMessage = {
      ...messageWithUrl(DATA_URL),
      blocks: [{ type: 'image-ref', path: '/tmp/pasted.png' }]
    }
    const [a, b] = await hydrateNativeChatImageRefs([remote, local], { cacheDir })
    expect(a.blocks).toEqual(remote.blocks)
    expect(b.blocks).toEqual(local.blocks)
  })

  it('caches a payload at the byte limit', () => {
    const cacheDir = freshCacheDir()
    const data = Buffer.alloc(NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES).toString('base64')
    const [hydrated] = hydrateNativeChatImageRefs(
      [messageWithUrl(`data:image/png;base64,${data}`)],
      { cacheDir }
    )
    const ref = hydrated?.blocks[1]
    if (ref?.type !== 'image-ref' || !ref.path) {
      throw new Error('expected an image at the size limit to be cached')
    }
    expect(statSync(ref.path).size).toBe(NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES)
  })

  it('refuses oversized payloads before allocating their decoded bytes', () => {
    const cacheDir = freshCacheDir()
    const data = Buffer.alloc(NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES + 1).toString('base64')
    const url = `data:image/png;base64,${data}`
    const decode = vi.spyOn(Buffer, 'from')
    try {
      const [hydrated] = hydrateNativeChatImageRefs([messageWithUrl(url)], { cacheDir })
      expect(hydrated?.blocks[1]).toEqual({ type: 'image-ref', url })
      expect(readdirSync(cacheDir)).toEqual([])
      expect(decode).not.toHaveBeenCalledWith(data, 'base64')
    } finally {
      decode.mockRestore()
    }
  })

  it('leaves malformed data: urls inline (fail-open)', async () => {
    const cacheDir = freshCacheDir()
    const bad = 'data:image/png;base64,%%%not-base64%%%'
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(bad)], { cacheDir })
    expect(hydrated.blocks[1]).toEqual({ type: 'image-ref', url: bad })
  })
})

describe('pruneNativeChatImageCache', () => {
  it('drops entries and temp files past retention and keeps everything else', async () => {
    const cacheDir = freshCacheDir()
    const old = (NATIVE_CHAT_IMAGE_CACHE_RETENTION_MS + 60_000) / 1000
    const now = Date.now()
    const stale = join(cacheDir, `${'a'.repeat(64)}.png`)
    const fresh = join(cacheDir, `${'b'.repeat(64)}.png`)
    const orphanTemp = join(cacheDir, `${'c'.repeat(64)}.png.x.tmp`)
    const unrelated = join(cacheDir, 'notes.txt')
    for (const file of [stale, fresh, orphanTemp, unrelated]) {
      writeFileSync(file, 'x')
    }
    for (const file of [stale, orphanTemp, unrelated]) {
      utimesSync(file, now / 1000 - old, now / 1000 - old)
    }

    await pruneNativeChatImageCache(cacheDir, now)

    expect(readdirSync(cacheDir).sort()).toEqual([`${'b'.repeat(64)}.png`, 'notes.txt'])
  })

  it('keeps an old entry that hydration just served, because serving refreshes it', async () => {
    const cacheDir = freshCacheDir()
    const digest = createHash('sha256').update(Buffer.from(PNG_1PX, 'base64')).digest('hex')
    const cached = join(cacheDir, `${digest}.png`)
    writeFileSync(cached, Buffer.from(PNG_1PX, 'base64'))
    const now = Date.now()
    const old = (NATIVE_CHAT_IMAGE_CACHE_RETENTION_MS + 60_000) / 1000
    utimesSync(cached, now / 1000 - old, now / 1000 - old)

    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    expect(hydrated.blocks[1]).toEqual({ type: 'image-ref', path: cached })
    await pruneNativeChatImageCache(cacheDir, now)

    expect(existsSync(cached)).toBe(true)
  })

  it('prunes again once the interval has passed, not on every read', async () => {
    const cacheDir = freshCacheDir()
    const now = Date.now()
    expect(pruneNativeChatImageCacheIfDue(cacheDir, now)).not.toBeNull()
    expect(pruneNativeChatImageCacheIfDue(cacheDir, now + 60_000)).toBeNull()
    const later = now + NATIVE_CHAT_IMAGE_CACHE_PRUNE_INTERVAL_MS + 1
    const stale = join(cacheDir, `${'d'.repeat(64)}.png`)
    writeFileSync(stale, 'x')
    const old = (NATIVE_CHAT_IMAGE_CACHE_RETENTION_MS + 60_000) / 1000
    utimesSync(stale, later / 1000 - old, later / 1000 - old)

    await pruneNativeChatImageCacheIfDue(cacheDir, later)

    expect(existsSync(stale)).toBe(false)
  })
})
