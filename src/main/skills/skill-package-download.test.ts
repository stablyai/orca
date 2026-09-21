import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_PACKAGE_CONTENT_TYPE } from '../../shared/skill-package-manifest'
import { downloadSkillPackageGrant } from './skill-package-download'

const roots: string[] = []
const bytes = Buffer.from('private skill package')
const digest = createHash('sha256').update(bytes).digest('hex')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-download-test-'))
  roots.push(root)
  return root
}

async function remainingDownloadFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory()
        ? (await readdir(join(root, entry.name))).map((name) => join(entry.name, name))
        : [entry.name]
    )
  )
  return nested.flat()
}

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  if (body && !headers.has('content-type')) {
    headers.set('content-type', SKILL_PACKAGE_CONTENT_TYPE)
  }
  return new Response(body, { ...init, headers })
}

function fetcher(implementation: (url: string) => Promise<Response>): typeof fetch {
  return vi.fn(async (input) => implementation(String(input))) as typeof fetch
}

async function input(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://storage.test/package.tar.gz?signature=private',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    expectedArchiveSha256: digest,
    expectedCompressedBytes: bytes.length,
    temporaryRoot: await temporaryRoot(),
    allowedOrigins: ['https://storage.test'],
    requireHttps: true,
    fetcher: fetcher(async () => response(bytes)),
    ...overrides
  }
}

describe('downloadSkillPackageGrant', () => {
  it('removes download bytes abandoned by a previous process', async () => {
    const downloadInput = await input()
    const abandoned = join(
      downloadInput.temporaryRoot,
      '.orca-skill-download-process-2147483647-abandoned'
    )
    await mkdir(abandoned)
    await writeFile(join(abandoned, 'package.tar.gz'), 'private bytes')

    const result = await downloadSkillPackageGrant(downloadInput)

    await expect(readFile(join(abandoned, 'package.tar.gz'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await result.cleanup()
  })

  it('streams a verified package into an owner-private temporary file', async () => {
    const downloadInput = await input()
    if (process.platform !== 'win32') {
      await chmod(downloadInput.temporaryRoot, 0o755)
    }
    const result = await downloadSkillPackageGrant(downloadInput)
    expect(await readFile(result.archivePath)).toEqual(bytes)
    expect(result.archiveSha256).toBe(digest)
    expect(result.compressedBytes).toBe(bytes.length)
    if (process.platform !== 'win32') {
      expect((await stat(downloadInput.temporaryRoot)).mode & 0o777).toBe(0o700)
      expect((await stat(dirname(result.archivePath))).mode & 0o777).toBe(0o700)
      expect((await stat(result.archivePath)).mode & 0o777).toBe(0o600)
    }
    await result.cleanup()
    await expect(readFile(result.archivePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects untrusted origins and insecure grant URLs before fetch', async () => {
    const untrusted = await input({ url: 'https://attacker.test/package.tar.gz' })
    await expect(downloadSkillPackageGrant(untrusted)).rejects.toThrow(
      'skill-download-origin-rejected'
    )
    expect(untrusted.fetcher).not.toHaveBeenCalled()

    const insecure = await input({
      url: 'http://storage.test/package.tar.gz',
      allowedOrigins: ['http://storage.test']
    })
    await expect(downloadSkillPackageGrant(insecure)).rejects.toThrow('skill-download-url-rejected')
  })

  it.each([
    'https://storage.test.attacker.test/package.tar.gz',
    'https://storage.test:444/package.tar.gz',
    'https://storage.test@attacker.test/package.tar.gz'
  ])('rejects host-confusion grant URL %s before fetch', async (url) => {
    const confused = await input({ url })

    await expect(downloadSkillPackageGrant(confused)).rejects.toThrow(/skill-download-.*-rejected/)
    expect(confused.fetcher).not.toHaveBeenCalled()
  })

  it('allows same-origin redirects but rejects signed cross-origin redirects', async () => {
    const sameOriginFetch = fetcher(async (url) =>
      url.includes('/first')
        ? response(null, { status: 307, headers: { location: '/second' } })
        : response(bytes)
    )
    const result = await downloadSkillPackageGrant(
      await input({
        url: 'https://storage.test/first?signature=private',
        fetcher: sameOriginFetch
      })
    )
    expect(sameOriginFetch).toHaveBeenCalledTimes(2)
    await result.cleanup()

    const crossOriginFetch = fetcher(async () =>
      response(null, {
        status: 307,
        headers: { location: 'https://other.test/package.tar.gz' }
      })
    )
    await expect(
      downloadSkillPackageGrant(
        await input({
          fetcher: crossOriginFetch,
          allowedOrigins: ['https://storage.test', 'https://other.test']
        })
      )
    ).rejects.toThrow('skill-download-cross-origin-redirect')
  })

  it('rejects protocol-relative host-confusion redirects', async () => {
    const confused = await input({
      fetcher: fetcher(async () =>
        response(null, { status: 307, headers: { location: '//storage.test.attacker.test/file' } })
      )
    })

    await expect(downloadSkillPackageGrant(confused)).rejects.toThrow(
      'skill-download-origin-rejected'
    )
  })

  it('deletes partial bytes after size and digest failures', async () => {
    const sizeInput = await input({
      expectedCompressedBytes: bytes.length - 1,
      fetcher: fetcher(async () => response(bytes))
    })
    await expect(downloadSkillPackageGrant(sizeInput)).rejects.toThrow('skill-download-size-limit')
    expect(await remainingDownloadFiles(sizeInput.temporaryRoot)).toEqual([])

    const digestInput = await input({ expectedArchiveSha256: '0'.repeat(64) })
    await expect(downloadSkillPackageGrant(digestInput)).rejects.toThrow(
      'skill-download-archive-digest-mismatch'
    )
    expect(await remainingDownloadFiles(digestInput.temporaryRoot)).toEqual([])
  })

  it('rejects expired grants without network access', async () => {
    const expired = await input({ expiresAt: new Date(Date.now() - 1).toISOString() })
    await expect(downloadSkillPackageGrant(expired)).rejects.toThrow('skill-download-grant-expired')
    expect(expired.fetcher).not.toHaveBeenCalled()
  })

  it('physically aborts a fetch stalled past grant expiry', async () => {
    vi.useFakeTimers()
    const stalled = await input({
      expiresAt: new Date(Date.now() + 100).toISOString(),
      fetcher: vi.fn(
        async (_input: URL | RequestInfo, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true
            })
          })
      ) as typeof fetch
    })

    const download = downloadSkillPackageGrant(stalled)
    const expectation = expect(download).rejects.toThrow('skill-download-grant-expired')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)
    await expectation
    vi.useRealTimers()
  })

  it('does not expire a far-future stalled fetch immediately when the timer delay overflows Node limits', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const stalled = await input({
      signal: caller.signal,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000 * 50).toISOString(),
      fetcher: vi.fn(
        async (_input: URL | RequestInfo, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true
            })
          })
      ) as typeof fetch
    })

    const download = downloadSkillPackageGrant(stalled)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    await expect(Promise.race([download, Promise.resolve('pending')])).resolves.toBe('pending')

    caller.abort()
    await expect(download).rejects.toThrow('skill-download-cancelled')
    vi.useRealTimers()
  })

  it('deletes partial bytes when a streaming download is cancelled', async () => {
    const controller = new AbortController()
    let sent = false
    const cancelled = await input({
      signal: controller.signal,
      fetcher: fetcher(async () =>
        response(
          new ReadableStream({
            pull(stream) {
              if (sent) {
                return
              }
              sent = true
              stream.enqueue(bytes.subarray(0, 4))
              queueMicrotask(() => controller.abort())
            }
          })
        )
      )
    })

    await expect(downloadSkillPackageGrant(cancelled)).rejects.toThrow('skill-download-cancelled')
    expect(await remainingDownloadFiles(cancelled.temporaryRoot)).toEqual([])
  })

  it('physically aborts a body read stalled past grant expiry and deletes partial bytes', async () => {
    vi.useFakeTimers()
    const stalled = await input({
      expiresAt: new Date(Date.now() + 100).toISOString(),
      fetcher: vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>
        init?.signal?.addEventListener(
          'abort',
          () => controller.error(init.signal?.reason ?? new Error('aborted')),
          { once: true }
        )
        return response(
          new ReadableStream({
            start(streamController) {
              controller = streamController
              controller.enqueue(bytes.subarray(0, 4))
            }
          })
        )
      }) as typeof fetch
    })

    const download = downloadSkillPackageGrant(stalled)
    const expectation = expect(download).rejects.toThrow('skill-download-grant-expired')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)
    await expectation
    expect(await remainingDownloadFiles(stalled.temporaryRoot)).toEqual([])
    vi.useRealTimers()
  })
})
