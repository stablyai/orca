import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_PIN,
  nodeRuntimeExecutablePath
} from '../../shared/node-runtime-pin'
import { materializeNodeRuntimeArchive } from './pinned-runtime-materializer'

const TARGET = 'linux-x64-glibc' as const
const originalAsset = { ...NODE_RUNTIME_ASSETS[TARGET] }
let root = ''

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fetcherFor(body: Uint8Array, signals: AbortSignal[] = []): typeof fetch {
  return vi.fn<typeof fetch>(async (_url, options) => {
    if (options?.signal) {
      signals.push(options.signal)
    }
    return new Response(Buffer.from(body), { status: 200 })
  })
}

/** A real .tar.gz laid out like the official one, so extraction runs the host's tar. */
async function nodeDistArchiveFixture(executable: Uint8Array): Promise<Uint8Array> {
  const staging = join(root, 'staging')
  const member = nodeRuntimeExecutablePath(TARGET, NODE_RUNTIME_ASSETS[TARGET].archive)
  await mkdir(join(staging, member, '..'), { recursive: true })
  await writeFile(join(staging, member), executable)
  await writeFile(join(staging, member.split('/')[0]!, 'README.md'), 'not extracted')
  const archivePath = join(root, 'archive.tar.gz')
  const result = await runProcess({
    program: 'tar',
    args: ['-czf', archivePath, '-C', staging, member.split('/')[0]!]
  })
  expect(result.code, result.stderr).toBe(0)
  return new Uint8Array(await readFile(archivePath))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-node-runtime-materializer-'))
})

afterEach(async () => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], originalAsset)
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('pinned Node runtime materializer', () => {
  it('keeps the verified archive for upload and refetches only when it is corrupted', async () => {
    const archive = await nodeDistArchiveFixture(new TextEncoder().encode('node'))
    Object.assign(NODE_RUNTIME_ASSETS[TARGET], { archiveSha256: sha256(archive) })
    const cacheRoot = join(root, 'cache')
    const signals: AbortSignal[] = []
    const fetcher = fetcherFor(archive, signals)

    const cached = await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })
    expect(cached.endsWith(originalAsset.archive)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(`/v${NODE_RUNTIME_PIN.version}/${originalAsset.archive}`),
      expect.objectContaining({ redirect: 'follow' })
    )
    expect(await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })).toBe(cached)
    expect(fetcher).toHaveBeenCalledOnce()

    await writeFile(cached, 'torn')
    const repaired = await materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher })
    expect(repaired).not.toBe(cached)
    expect(sha256(new Uint8Array(await readFile(repaired)))).toBe(sha256(archive))
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
  })

  it('refuses an archive that does not match the pin before caching it', async () => {
    const archive = await nodeDistArchiveFixture(new TextEncoder().encode('node'))
    await expect(
      materializeNodeRuntimeArchive(TARGET, join(root, 'cache'), { fetcher: fetcherFor(archive) })
    ).rejects.toThrow('Node archive checksum mismatch')
  })
})

describe('pinned runtime archive request ownership', () => {
  it.each(['http-error', 'oversized-declaration', 'staging-collision'] as const)(
    'retires the owned %s request without cancelling its caller',
    async (failure) => {
      const cacheRoot = join(root, 'cache')
      const archiveRoot = join(cacheRoot, 'node', 'archives')
      const parent = new AbortController()
      const signals: AbortSignal[] = []
      const cancel = vi.fn()
      const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
        if (options?.signal) {
          signals.push(options.signal)
        }
        if (failure === 'staging-collision') {
          const stage = (await readdir(archiveRoot)).find((name) => name.startsWith('.download-'))
          if (!stage) {
            throw new Error('Missing download staging directory')
          }
          await mkdir(join(archiveRoot, stage, originalAsset.archive))
        }
        return new Response(new ReadableStream({ cancel }), {
          status: failure === 'http-error' ? 404 : 200,
          statusText: 'Unavailable',
          headers:
            failure === 'oversized-declaration'
              ? { 'content-length': String(200 * 1024 * 1024 + 1) }
              : {}
        })
      })
      const pending = materializeNodeRuntimeArchive(TARGET, cacheRoot, {
        fetcher,
        signal: parent.signal
      })
      await (failure === 'staging-collision'
        ? expect(pending).rejects.toMatchObject({ code: 'EEXIST' })
        : expect(pending).rejects.toThrow(
            failure === 'http-error'
              ? 'Node download failed: 404 Unavailable'
              : 'Node download exceeded the archive size limit'
          ))
      expect(cancel).toHaveBeenCalledOnce()
      expect(signals).toHaveLength(1)
      expect(signals[0]?.aborted).toBe(true)
      expect(parent.signal.aborted).toBe(false)
      expect(await readdir(archiveRoot)).toEqual([])
    }
  )

  it('keeps the caller cancellation reason and removes the incomplete stage', async () => {
    const cacheRoot = join(root, 'cache')
    const parent = new AbortController()
    const reason = new Error('deployment cancelled')
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>(async () => {
      queueMicrotask(() => parent.abort(reason))
      return new Response(new ReadableStream({ cancel }))
    })
    await expect(
      materializeNodeRuntimeArchive(TARGET, cacheRoot, { fetcher, signal: parent.signal })
    ).rejects.toBe(reason)
    expect(parent.signal.reason).toBe(reason)
    expect(cancel).toHaveBeenCalledOnce()
    expect(await readdir(join(cacheRoot, 'node', 'archives'))).toEqual([])
  })
})
