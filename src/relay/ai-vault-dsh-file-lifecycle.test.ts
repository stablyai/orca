import type * as NodeFsPromises from 'node:fs/promises'
import { constants } from 'node:fs'
import { mkdtemp, mkdir, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

const seams = vi.hoisted(() => {
  const seams: {
    afterStat: null | (() => Promise<void>)
    afterOpen: null | ((handle: FileHandle) => Promise<void>)
    handles: FileHandle[]
    flags: (string | number)[]
  } = { afterStat: null, afterOpen: null, handles: [], flags: [] }
  return seams
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args)
      await seams.afterStat?.()
      return result
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      seams.handles.push(handle)
      seams.flags.push(args[1] ?? 'r')
      await seams.afterOpen?.(handle)
      return handle
    }
  }
})
import { readRelayTranscriptBytes } from './ai-vault-transcript-stream'
import { BinarySessionTranscriptError } from '../main/ai-vault/remote-session-content-lines'
import { localDshTranscriptBytes } from '../main/ai-vault/session-scanner-dsh-stream'

const roots: string[] = []
afterEach(async () => {
  seams.afterStat = null
  seams.afterOpen = null
  seams.handles = []
  seams.flags = []
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function file(compressed = true) {
  const root = await mkdtemp(join(tmpdir(), 'orca-dsh-admission-'))
  roots.push(root)
  const path = join(
    root,
    'sessions',
    'project',
    'session-admission',
    `session.v1.jsonl${compressed ? '.zstd' : ''}`
  )
  await mkdir(dirname(path), { recursive: true })
  const plain = Buffer.from('{"type":"session","version":1}\n')
  const bytes = compressed ? zstdCompressSync(plain) : plain
  await writeFile(path, bytes)
  return { root, path, bytes }
}
async function collect(source: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = []
  for await (const chunk of source) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function expectClosed() {
  expect(seams.handles.length).toBeGreaterThan(0)
  for (const handle of seams.handles) {
    await expect(handle.read(Buffer.alloc(1), 0, 1, 0)).rejects.toMatchObject({ code: 'EBADF' })
  }
}

describe('DSH regular descriptor admission and lifetime', () => {
  it.each([false, true])(
    'keeps plain/compressed bytes and closes local and relay readers (compressed=%s)',
    async (compressed) => {
      const { path, bytes } = await file(compressed)
      expect(
        await collect(
          readRelayTranscriptBytes(path, undefined, compressed ? 'dsh-zstd' : undefined)
        )
      ).toEqual(bytes)
      expect(await collect(localDshTranscriptBytes(path))).toEqual(bytes)
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
      expect(seams.flags).toEqual([flags, flags])
      await expectClosed()
    }
  )

  it('retains ordinary legacy reads and default binary rejection', async () => {
    const { root, path } = await file()
    const legacy = join(root, 'legacy.jsonl')
    await writeFile(legacy, 'legacy text\n')
    expect(await collect(readRelayTranscriptBytes(legacy))).toEqual(Buffer.from('legacy text\n'))
    expect(seams.flags[0]).toBe('r')
    await expect(collect(readRelayTranscriptBytes(path))).rejects.toThrow(
      BinarySessionTranscriptError
    )
    await expectClosed()
  })

  it('reads the admitted descriptor when the path is replaced after open', async () => {
    const { path, bytes } = await file()
    seams.afterOpen = async () => {
      seams.afterOpen = null
      await rename(path, `${path}.original`)
      await writeFile(path, Buffer.alloc(4))
    }
    expect(await collect(readRelayTranscriptBytes(path, undefined, 'dsh-zstd'))).toEqual(bytes)
    await expectClosed()
  })

  it('admits a replacement regular file after the path stat without claiming inode equality', async () => {
    const { path } = await file(false)
    const replacement = Buffer.from('replacement text\n')
    seams.afterStat = async () => {
      seams.afterStat = null
      await rename(path, `${path}.original`)
      await writeFile(path, replacement)
    }
    expect(await collect(readRelayTranscriptBytes(path))).toEqual(replacement)
    await expectClosed()
  })

  it('rejects a nonregular opened descriptor before probing and closes it', async () => {
    const { path } = await file()
    seams.afterOpen = async (handle) => {
      const stats = await handle.stat()
      vi.spyOn(stats, 'isFile').mockReturnValue(false)
      vi.spyOn(handle, 'stat').mockResolvedValue(stats)
    }
    await expect(collect(readRelayTranscriptBytes(path, undefined, 'dsh-zstd'))).rejects.toThrow(
      'regular file'
    )
    await expectClosed()
  })

  it.each(['before-open', 'after-path-stat', 'after-open', 'after-descriptor-stat'] as const)(
    'propagates cancellation %s and closes every acquired descriptor',
    async (phase) => {
      const { path } = await file()
      const controller = new AbortController()
      if (phase === 'before-open') {
        controller.abort()
      }
      if (phase === 'after-path-stat') {
        seams.afterStat = async () => {
          controller.abort()
        }
      }
      if (phase === 'after-open') {
        seams.afterOpen = async () => {
          controller.abort()
        }
      }
      if (phase === 'after-descriptor-stat') {
        seams.afterOpen = async (handle) => {
          const stats = await handle.stat()
          vi.spyOn(handle, 'stat').mockImplementation(async () => {
            controller.abort()
            return stats
          })
        }
      }
      await expect(
        collect(readRelayTranscriptBytes(path, controller.signal, 'dsh-zstd'))
      ).rejects.toMatchObject({ name: 'AbortError' })
      if (phase === 'before-open' || phase === 'after-path-stat') {
        expect(seams.handles).toEqual([])
      } else {
        await expectClosed()
      }
    }
  )

  it.each(['relay', 'local'] as const)(
    'closes the active %s descriptor on cancellation during reading',
    async (reader) => {
      const { path } = await file(false)
      await writeFile(path, 'line\n'.repeat(400_000))
      const controller = new AbortController()
      const source =
        reader === 'relay'
          ? readRelayTranscriptBytes(path, controller.signal)
          : localDshTranscriptBytes(path, controller.signal)
      const iterator = source[Symbol.asyncIterator]()
      expect((await iterator.next()).done).toBe(false)
      controller.abort()
      await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
      await expectClosed()
    }
  )

  it('closes the descriptor on invalid magic, suffix and root errors', async () => {
    const { root, path, bytes } = await file()
    const plain = path.slice(0, -5)
    const unrelated = join(root, 'session.v1.jsonl.zstd')
    await writeFile(plain, bytes)
    await writeFile(unrelated, bytes)
    await writeFile(path, Buffer.from('invalid magic'))
    for (const invalid of [path, plain, unrelated]) {
      await expect(
        collect(readRelayTranscriptBytes(invalid, undefined, 'dsh-zstd'))
      ).rejects.toThrow('canonical')
    }
    await expectClosed()
  })
})
