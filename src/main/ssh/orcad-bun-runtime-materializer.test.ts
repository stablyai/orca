import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_BUN_RUNTIME_FILENAME } from '../../shared/orcad-artifacts'
import { ORCAD_BUN_RELEASE_ASSETS, ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import { setMainHttpClient } from '../network/http-client'
import { materializeCachedOrcadBunRuntime } from './orcad-bun-runtime-materializer'

const extraction = vi.hoisted(() => ({ executable: new Uint8Array(), executableName: 'bun' }))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(async (spec: { args: string[] }) => {
    const extracted = join(spec.args.at(-1)!, 'bun-linux-x64')
    await mkdir(extracted, { recursive: true })
    await writeFile(join(extracted, extraction.executableName), extraction.executable)
    return { code: 0, stdout: '', stderr: '' }
  })
}))

const TARGET = 'linux-x64-glibc' as const
const originalAsset = { ...ORCAD_BUN_RELEASE_ASSETS[TARGET] }
let cacheRoot = ''

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function responseFetcher(body: Uint8Array, declaredLength = body.byteLength): typeof fetch {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(Buffer.from(body), {
        status: 200,
        headers: { 'content-length': String(declaredLength) }
      })
  )
}

beforeEach(async () => {
  extraction.executableName = 'bun'
  cacheRoot = await mkdtemp(join(tmpdir(), 'orca-bun-runtime-materializer-'))
  Object.assign(ORCAD_BUN_RELEASE_ASSETS[TARGET], originalAsset)
})

afterEach(async () => {
  vi.useRealTimers()
  setMainHttpClient(null)
  Object.assign(ORCAD_BUN_RELEASE_ASSETS[TARGET], originalAsset)
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('materializeCachedOrcadBunRuntime', () => {
  it('caches Windows PE files as .exe without renaming a legacy cache entry', async () => {
    const target = 'win32-x64' as const
    const savedAsset = { ...ORCAD_BUN_RELEASE_ASSETS[target] }
    const archive = new TextEncoder().encode('windows archive')
    const executable = new TextEncoder().encode('windows executable')
    extraction.executable = executable
    extraction.executableName = 'bun.exe'
    Object.assign(ORCAD_BUN_RELEASE_ASSETS[target], {
      sha256: sha256(archive),
      executableSha256: sha256(executable)
    })
    const runtimeDir = join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, target)
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'bun-runtime'), 'legacy')
    try {
      const runtimePath = await materializeCachedOrcadBunRuntime(target, cacheRoot, {
        fetcher: responseFetcher(archive)
      })
      expect(runtimePath).toBe(join(runtimeDir, 'bun-runtime.exe'))
      expect(await readFile(runtimePath)).toEqual(Buffer.from(executable))
      expect(await readFile(join(runtimeDir, 'bun-runtime'), 'utf8')).toBe('legacy')
    } finally {
      Object.assign(ORCAD_BUN_RELEASE_ASSETS[target], savedAsset)
    }
  })

  it('reuses a checksum-valid cached runtime without fetching', async () => {
    const runtime = new TextEncoder().encode('cached bun')
    ORCAD_BUN_RELEASE_ASSETS[TARGET].executableSha256 = sha256(runtime)
    const runtimeDir = join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET)
    const runtimePath = join(runtimeDir, ORCAD_BUN_RUNTIME_FILENAME)
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(runtimePath, runtime)
    const fetcher = vi.fn<typeof fetch>()

    await expect(materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })).resolves.toBe(
      runtimePath
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readFile(runtimePath)).toEqual(Buffer.from(runtime))
  })

  it('downloads, verifies, extracts, and atomically caches the runtime', async () => {
    const archive = new TextEncoder().encode('pinned archive')
    const executable = new TextEncoder().encode('pinned bun executable')
    extraction.executable = executable
    Object.assign(ORCAD_BUN_RELEASE_ASSETS[TARGET], {
      sha256: sha256(archive),
      executableSha256: sha256(executable)
    })
    const fetcher = responseFetcher(archive)

    const runtimePath = await materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })

    expect(await readFile(runtimePath)).toEqual(Buffer.from(executable))
    if (process.platform !== 'win32') {
      expect((await stat(runtimePath)).mode & 0o111).toBe(0o111)
    }
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(`/bun-v${ORCAD_BUN_VERSION}/bun-linux-x64.zip`),
      expect.objectContaining({ redirect: 'follow' })
    )
    expect((await readdir(join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET))).sort()).toEqual(
      [ORCAD_BUN_RUNTIME_FILENAME]
    )
  })

  it('refuses an oversized declared archive before reading its body', async () => {
    const fetcher = responseFetcher(new Uint8Array([1]), 200 * 1024 * 1024 + 1)

    await expect(materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })).rejects.toThrow(
      'Bun download exceeded the archive size limit'
    )
    await expect(
      access(join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET, ORCAD_BUN_RUNTIME_FILENAME))
    ).rejects.toThrow()
    expect(await readdir(join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET))).toEqual([])
  })

  it('removes temporary data after an archive checksum mismatch', async () => {
    const archive = new TextEncoder().encode('tampered archive')
    const fetcher = responseFetcher(archive)

    await expect(materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })).rejects.toThrow(
      'Bun archive checksum mismatch'
    )
    expect(await readdir(join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET))).toEqual([])
  })

  it('refuses an executable mismatch even when the archive matches its pin', async () => {
    const archive = new TextEncoder().encode('pinned archive')
    extraction.executable = new TextEncoder().encode('incorrect executable')
    ORCAD_BUN_RELEASE_ASSETS[TARGET].sha256 = sha256(archive)
    await expect(
      materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher: responseFetcher(archive) })
    ).rejects.toThrow('Bun executable checksum mismatch')
    expect(await readdir(join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET))).toEqual([])
  })

  it('cleans an aborted download before publishing any executable', async () => {
    const controller = new AbortController()
    controller.abort(new Error('deployment cancelled'))
    await expect(
      materializeCachedOrcadBunRuntime(TARGET, cacheRoot, {
        fetcher: responseFetcher(new Uint8Array([1])),
        signal: controller.signal
      })
    ).rejects.toThrow('deployment cancelled')
    await expect(access(join(cacheRoot, 'bun'))).rejects.toThrow()
  })
})

it('publishes concurrent runtime downloads without removing or replacing the winning executable', async () => {
  const archive = new TextEncoder().encode('pinned archive')
  extraction.executable = new TextEncoder().encode('pinned runtime')
  Object.assign(ORCAD_BUN_RELEASE_ASSETS[TARGET], {
    sha256: sha256(archive),
    executableSha256: sha256(extraction.executable)
  })
  let finishSecond: (response: Response) => void = () => {}
  const secondFetcher = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        finishSecond = resolve
      })
  )
  const second = materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher: secondFetcher })
  await vi.waitFor(() => expect(secondFetcher).toHaveBeenCalledOnce())
  const firstPath = await materializeCachedOrcadBunRuntime(TARGET, cacheRoot, {
    fetcher: responseFetcher(archive)
  })
  const firstIdentity = await stat(firstPath)
  finishSecond(new Response(Buffer.from(archive)))
  expect(await second).toBe(firstPath)
  expect((await stat(firstPath)).ino).toBe(firstIdentity.ino)
  expect(await readFile(firstPath)).toEqual(Buffer.from(extraction.executable))
})

it('repairs a corrupt published runtime beside the old inode and reuses the repair', async () => {
  const archive = new TextEncoder().encode('pinned archive')
  extraction.executable = new TextEncoder().encode('pinned runtime')
  Object.assign(ORCAD_BUN_RELEASE_ASSETS[TARGET], {
    sha256: sha256(archive),
    executableSha256: sha256(extraction.executable)
  })
  const runtimeDir = join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET)
  const runtimePath = join(runtimeDir, ORCAD_BUN_RUNTIME_FILENAME)
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(runtimePath, 'corrupt')
  const fetcher = responseFetcher(archive)
  const repaired = await materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })
  expect(repaired).not.toBe(runtimePath)
  expect(await readFile(repaired)).toEqual(Buffer.from(extraction.executable))
  expect(await materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })).toBe(repaired)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(await readFile(runtimePath, 'utf8')).toBe('corrupt')
})

it('uses the configured HTTP client for deployment downloads', async () => {
  const archive = new TextEncoder().encode('proxy archive')
  extraction.executable = new TextEncoder().encode('proxy runtime')
  Object.assign(ORCAD_BUN_RELEASE_ASSETS[TARGET], {
    sha256: sha256(archive),
    executableSha256: sha256(extraction.executable)
  })
  const fetcher = responseFetcher(archive)
  setMainHttpClient({ fetch: fetcher, proxySession: () => null })
  await materializeCachedOrcadBunRuntime(TARGET, cacheRoot, {})
  expect(fetcher).toHaveBeenCalledOnce()
})

it('allows a progressing download to exceed two minutes', async () => {
  vi.useFakeTimers()
  const first = new TextEncoder().encode('first')
  const second = new TextEncoder().encode('second')
  extraction.executable = new TextEncoder().encode('slow runtime')
  Object.assign(ORCAD_BUN_RELEASE_ASSETS[TARGET], {
    sha256: sha256(Buffer.concat([first, second])),
    executableSha256: sha256(extraction.executable)
  })
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let signal: AbortSignal | null | undefined
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    signal = options?.signal
    return new Response(
      new ReadableStream({
        start(controller) {
          stream = controller
        }
      })
    )
  })
  const pending = materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(90_000)
  stream!.enqueue(first)
  await vi.waitFor(async () => {
    const runtimeDir = join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET)
    const temporary = (await readdir(runtimeDir)).find((entry) => entry.startsWith('.download-'))!
    expect(
      (await stat(join(runtimeDir, temporary, ORCAD_BUN_RELEASE_ASSETS[TARGET].filename))).size
    ).toBe(first.length)
  })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(signal?.aborted).toBe(false)
  stream!.enqueue(second)
  stream!.close()
  expect(await readFile(await pending)).toEqual(Buffer.from(extraction.executable))
})

it('aborts a stalled body and removes the unfinished download', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })))
  const pending = materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })
  const rejected = expect(pending).rejects.toThrow('Bun download stalled')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(120_000)
  await rejected
  expect(cancel).toHaveBeenCalledOnce()
  expect(await readdir(join(cacheRoot, 'bun', `v${ORCAD_BUN_VERSION}`, TARGET))).toEqual([])
})
