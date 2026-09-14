import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadSkillPackageToSignedPolicy } from './skill-cloud-direct-upload'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('uploadSkillPackageToSignedPolicy', () => {
  it('allows a slow progressing upload to continue beyond one minute', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-cloud-upload-'))
    roots.push(root)
    const archivePath = join(root, 'package.tar.gz')
    const archive = Buffer.alloc(3 * 64 * 1024, 0x61)
    await writeFile(archivePath, archive)
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let chunksSeen = 0
    const chunkWaiters = new Set<() => void>()
    const waitForChunk = async (count: number): Promise<void> => {
      if (chunksSeen >= count) {
        return
      }
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (chunksSeen >= count) {
            chunkWaiters.delete(check)
            resolve()
          }
        }
        chunkWaiters.add(check)
      })
    }
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      markStarted()
      const body = init?.body as unknown as AsyncIterable<Buffer>
      for await (const _chunk of body) {
        chunksSeen += 1
        chunkWaiters.forEach((notify) => notify())
        await new Promise<void>((resolve) => setTimeout(resolve, 30_000))
      }
      return new Response(null, { status: 204 })
    })
    const progress = vi.fn()
    const upload = uploadSkillPackageToSignedPolicy({
      policy: {
        url: 'https://storage.googleapis.com/upload',
        fields: {},
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
      },
      archivePath,
      expectedBytes: archive.length,
      fetcher: fetcher as typeof fetch,
      onProgress: progress
    })

    await started
    await waitForChunk(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await waitForChunk(2)
    await vi.advanceTimersByTimeAsync(30_000)
    await waitForChunk(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(progress).toHaveBeenCalled()
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(29_000)
    await waitForChunk(4)
    await vi.advanceTimersByTimeAsync(30_000)
    await waitForChunk(5)
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(upload).resolves.toBeUndefined()
  })

  it('streams exact bytes with policy fields and bounded progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-cloud-upload-'))
    roots.push(root)
    const archivePath = join(root, 'package.tar.gz')
    const archive = Buffer.from('private-package-bytes')
    await writeFile(archivePath, archive)
    let uploaded = Buffer.alloc(0)
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const chunks: Buffer[] = []
      const body = init?.body as unknown as AsyncIterable<Buffer>
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk))
      }
      uploaded = Buffer.concat(chunks)
      expect(Number(init?.headers && new Headers(init.headers).get('content-length'))).toBe(
        uploaded.length
      )
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const progress = vi.fn()

    await uploadSkillPackageToSignedPolicy({
      policy: {
        url: 'https://storage.googleapis.com/upload',
        fields: { key: 'uploads/private/package.tar.gz', policy: 'opaque-policy' }
      },
      archivePath,
      expectedBytes: archive.length,
      fetcher,
      onProgress: progress
    })

    expect(uploaded.includes(archive)).toBe(true)
    expect(uploaded.toString('utf8')).toContain('opaque-policy')
    expect(progress).toHaveBeenLastCalledWith(archive.length)
  })

  it('rejects insecure destinations and source drift before upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-cloud-upload-'))
    roots.push(root)
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, 'bytes')
    await expect(
      uploadSkillPackageToSignedPolicy({
        policy: { url: 'http://storage.test/upload', fields: {} },
        archivePath,
        expectedBytes: 5
      })
    ).rejects.toThrow('skill-cloud-upload-url-invalid')
    await expect(
      uploadSkillPackageToSignedPolicy({
        policy: { url: 'https://storage.test/upload', fields: {} },
        archivePath,
        expectedBytes: 4
      })
    ).rejects.toThrow('skill-cloud-upload-source-changed')
    await expect(
      uploadSkillPackageToSignedPolicy({
        policy: {
          url: 'https://storage.test/upload',
          fields: {},
          expiresAt: 'not-a-date'
        },
        archivePath,
        expectedBytes: 5
      })
    ).rejects.toThrow('skill-cloud-upload-policy-expiry-invalid')
  })

  it('bounds a stalled signed upload even without a caller-owned signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-cloud-upload-'))
    roots.push(root)
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, 'bytes')
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    ) as typeof fetch

    const upload = uploadSkillPackageToSignedPolicy({
      policy: { url: 'https://storage.googleapis.com/upload', fields: {} },
      archivePath,
      expectedBytes: 5,
      fetcher,
      timeoutMs: 25
    })
    const startedAt = Date.now()

    await expect(upload).rejects.toThrow('skill-cloud-upload-timeout')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
