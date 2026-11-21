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
    // Read chunk size depends on the runtime and platform, so the case advances one 30s delay
    // per chunk until the upload settles instead of counting chunks.
    let chunkDelayPending = false
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = init?.body as unknown as AsyncIterable<Buffer>
      for await (const _chunk of body) {
        chunkDelayPending = true
        await new Promise<void>((resolve) => setTimeout(resolve, 30_000))
        chunkDelayPending = false
      }
      return new Response(null, { status: 204 })
    })
    const progress = vi.fn()
    let settled = false
    const startedAt = Date.now()
    const upload = uploadSkillPackageToSignedPolicy({
      policy: {
        url: 'https://storage.googleapis.com/upload',
        fields: {},
        expiresAt: new Date(startedAt + 10 * 60_000).toISOString()
      },
      archivePath,
      expectedBytes: archive.length,
      fetcher: fetcher as typeof fetch,
      onProgress: progress
    }).finally(() => {
      settled = true
    })

    // Bounded by the 10 minute policy expiry so a body that never ends fails instead of hanging.
    for (let step = 0; step < 20 && !settled; step += 1) {
      await vi.waitUntil(() => settled || chunkDelayPending, { timeout: 5_000 })
      await vi.advanceTimersByTimeAsync(30_000)
    }

    expect(settled).toBe(true)
    await expect(upload).resolves.toBeUndefined()
    expect(Date.now() - startedAt).toBeGreaterThan(60_000)
    expect(progress).toHaveBeenCalledWith(archive.length)
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
  })

  it('streams exact bytes with policy fields and bounded progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-cloud-upload-'))
    roots.push(root)
    const archivePath = join(root, 'package.tar.gz')
    const archive = Buffer.from('private-package-bytes')
    await writeFile(archivePath, archive)
    let uploaded = Buffer.alloc(0)
    let contentType = ''
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      uploaded = Buffer.from(await new Response(init?.body).arrayBuffer())
      contentType = new Headers(init?.headers).get('content-type') ?? ''
      expect(Number(init?.headers && new Headers(init.headers).get('content-length'))).toBe(
        uploaded.length
      )
      return new Response(null, { status: 204 })
    })
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

    const form = await new Response(uploaded, {
      headers: { 'content-type': contentType }
    }).formData()
    expect(form.get('key')).toBe('uploads/private/package.tar.gz')
    expect(form.get('policy')).toBe('opaque-policy')
    const file = form.get('file')
    expect(file).toBeInstanceOf(File)
    if (!(file instanceof File)) {
      throw new Error('Expected uploaded package file')
    }
    expect(Buffer.from(await file.arrayBuffer())).toEqual(archive)
    expect(file.name).toBe('package.tar.gz')
    expect(uploaded.toString('utf8')).toContain(
      'Content-Disposition: form-data; name="file"; filename="package.tar.gz"\r\nContent-Type: application/vnd.orca.skill+tar+gzip\r\n\r\n'
    )
    const sent = progress.mock.calls.map(([bytes]) => bytes)
    expect(sent).not.toHaveLength(0)
    for (const [index, bytes] of sent.entries()) {
      expect(bytes).toBeGreaterThanOrEqual(index === 0 ? 0 : sent[index - 1])
      expect(bytes).toBeLessThanOrEqual(archive.length)
    }
    expect(sent.at(-1)).toBe(archive.length)
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
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-cloud-upload-'))
    roots.push(root)
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, 'bytes')
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          markStarted()
        })
    )

    const upload = uploadSkillPackageToSignedPolicy({
      policy: { url: 'https://storage.googleapis.com/upload', fields: {} },
      archivePath,
      expectedBytes: 5,
      fetcher,
      timeoutMs: 25
    })
    const expectation = expect(upload).rejects.toThrow('skill-cloud-upload-timeout')
    await started
    await vi.advanceTimersByTimeAsync(24)
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expectation
  })
})
