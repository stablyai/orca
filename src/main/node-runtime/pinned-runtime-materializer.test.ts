import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_PIN,
  nodeRuntimeExecutablePath,
  SERVER_TARGETS,
  type ServerTarget
} from '../../shared/node-runtime-pin'
import { setMainHttpClient } from '../network/http-client'
import { runProcess } from '@orca/process-host'
import { materializeCachedNodeRuntime } from './pinned-runtime-materializer'
import { RUNTIME_ARCHIVE_RETRY_DELAYS_MS } from './runtime-archive-download'

const extraction = vi.hoisted(() => ({ executable: new Uint8Array(), member: '' }))

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(async (spec: { args: string[] }) => {
    const flag = spec.args.includes('-C') ? '-C' : '-d'
    const extracted = join(spec.args[spec.args.indexOf(flag) + 1]!, ...extraction.member.split('/'))
    await mkdir(join(extracted, '..'), { recursive: true })
    await writeFile(extracted, extraction.executable)
    return { code: 0, stdout: '', stderr: '' }
  })
}))

const TARGET = 'linux-x64-glibc' as const
const originalAssets = structuredClone(NODE_RUNTIME_ASSETS)
let cacheRoot = ''

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function runtimeDirFor(target: ServerTarget = TARGET): string {
  return join(cacheRoot, 'node', NODE_RUNTIME_ASSETS[target].executableSha256)
}

function pin(target: ServerTarget, archive: Uint8Array, executable?: Uint8Array): void {
  NODE_RUNTIME_ASSETS[target].archiveSha256 = sha256(archive)
  if (executable) {
    NODE_RUNTIME_ASSETS[target].executableSha256 = sha256(executable)
  }
  extraction.member = nodeRuntimeExecutablePath(target, NODE_RUNTIME_ASSETS[target].archive)
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
  extraction.member = nodeRuntimeExecutablePath(TARGET, NODE_RUNTIME_ASSETS[TARGET].archive)
  cacheRoot = await mkdtemp(join(tmpdir(), 'orca-node-runtime-executable-'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  setMainHttpClient(null)
  for (const target of SERVER_TARGETS) {
    Object.assign(NODE_RUNTIME_ASSETS[target], originalAssets[target])
  }
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('materializeCachedNodeRuntime', () => {
  it('caches a Windows executable under its upstream name, keyed by its digest', async () => {
    const target = 'win32-x64' as const
    const archive = new TextEncoder().encode('windows archive')
    const executable = new TextEncoder().encode('windows executable')
    extraction.executable = executable
    pin(target, archive, executable)
    const runtimePath = await materializeCachedNodeRuntime(target, cacheRoot, {
      fetcher: responseFetcher(archive)
    })
    expect(runtimePath).toBe(join(runtimeDirFor(target), 'node.exe'))
    expect(await readFile(runtimePath)).toEqual(Buffer.from(executable))
  })

  it('reuses a checksum-valid cached runtime without fetching', async () => {
    const runtime = new TextEncoder().encode('cached node')
    NODE_RUNTIME_ASSETS[TARGET].executableSha256 = sha256(runtime)
    const runtimeDir = runtimeDirFor()
    const runtimePath = join(runtimeDir, 'node')
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(runtimePath, runtime)
    const fetcher = vi.fn<typeof fetch>()

    await expect(materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })).resolves.toBe(
      runtimePath
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readFile(runtimePath)).toEqual(Buffer.from(runtime))
  })

  it('downloads, verifies, extracts, and atomically caches the runtime', async () => {
    const archive = new TextEncoder().encode('pinned archive')
    const executable = new TextEncoder().encode('pinned node executable')
    extraction.executable = executable
    pin(TARGET, archive, executable)
    const fetcher = responseFetcher(archive)

    const runtimePath = await materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })

    expect(await readFile(runtimePath)).toEqual(Buffer.from(executable))
    if (process.platform !== 'win32') {
      expect((await stat(runtimePath)).mode & 0o111).toBe(0o111)
    }
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(`/v${NODE_RUNTIME_PIN.version}/${originalAssets[TARGET].archive}`),
      expect.objectContaining({ redirect: 'follow' })
    )
    expect(await readdir(runtimeDirFor())).toEqual(['node'])
  })

  it('refuses an oversized declared archive before reading its body', async () => {
    const fetcher = responseFetcher(new Uint8Array([1]), 200 * 1024 * 1024 + 1)

    await expect(materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })).rejects.toThrow(
      'Node download exceeded the archive size limit'
    )
    await expect(access(join(runtimeDirFor(), 'node'))).rejects.toThrow()
    expect(await readdir(runtimeDirFor())).toEqual([])
  })

  it('removes temporary data after an archive checksum mismatch', async () => {
    const archive = new TextEncoder().encode('tampered archive')
    const fetcher = responseFetcher(archive)

    await expect(materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })).rejects.toThrow(
      'Node archive checksum mismatch'
    )
    expect(await readdir(runtimeDirFor())).toEqual([])
  })

  it('refuses an executable mismatch even when the archive matches its pin', async () => {
    const archive = new TextEncoder().encode('pinned archive')
    extraction.executable = new TextEncoder().encode('incorrect executable')
    pin(TARGET, archive)
    await expect(
      materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher: responseFetcher(archive) })
    ).rejects.toThrow('Node executable checksum mismatch')
    expect(await readdir(runtimeDirFor())).toEqual([])
  })

  // Both cases spawn for real, so the assertion is against the errno Node actually reports:
  // a missing program rejects asynchronously with ENOENT, while a program path whose parent is a
  // regular file throws ENOTDIR synchronously out of `spawn` itself.
  it.each([
    ['absent', (): string => join(cacheRoot, 'absent-extractor')],
    ['unreachable through a file', (): string => join(cacheRoot, 'plain-file', 'unzip')]
  ])('names the %s extractor and the override when it cannot be launched', async (_label, path) => {
    const target = 'win32-x64' as const
    const archive = new TextEncoder().encode('unextractable archive')
    pin(target, archive)
    await writeFile(join(cacheRoot, 'plain-file'), 'not a directory')
    const { runProcess: spawnForReal } = await vi.importActual<{
      runProcess: typeof runProcess
    }>('@orca/process-host')
    vi.mocked(runProcess).mockImplementationOnce(spawnForReal)
    vi.stubEnv('ORCA_UNZIP_BIN', path())

    await expect(
      materializeCachedNodeRuntime(target, cacheRoot, { fetcher: responseFetcher(archive) })
    ).rejects.toThrow(/install unzip, or set ORCA_UNZIP_BIN/)
    expect(await readdir(runtimeDirFor(target))).toEqual([])
  })

  it('cleans an aborted download before publishing any executable', async () => {
    const controller = new AbortController()
    controller.abort(new Error('deployment cancelled'))
    await expect(
      materializeCachedNodeRuntime(TARGET, cacheRoot, {
        fetcher: responseFetcher(new Uint8Array([1])),
        signal: controller.signal
      })
    ).rejects.toThrow('deployment cancelled')
    await expect(access(join(cacheRoot, 'node'))).rejects.toThrow()
  })
})

it('publishes concurrent runtime downloads without removing or replacing the winning executable', async () => {
  const archive = new TextEncoder().encode('pinned archive')
  extraction.executable = new TextEncoder().encode('pinned runtime')
  pin(TARGET, archive, extraction.executable)
  let finishSecond: (response: Response) => void = () => {}
  const secondFetcher = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        finishSecond = resolve
      })
  )
  const second = materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher: secondFetcher })
  await vi.waitFor(() => expect(secondFetcher).toHaveBeenCalledOnce())
  const firstPath = await materializeCachedNodeRuntime(TARGET, cacheRoot, {
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
  pin(TARGET, archive, extraction.executable)
  const runtimeDir = runtimeDirFor()
  const runtimePath = join(runtimeDir, 'node')
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(runtimePath, 'corrupt')
  const fetcher = responseFetcher(archive)
  const repaired = await materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })
  expect(repaired).not.toBe(runtimePath)
  expect(await readFile(repaired)).toEqual(Buffer.from(extraction.executable))
  expect(await materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })).toBe(repaired)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(await readFile(runtimePath, 'utf8')).toBe('corrupt')
})

it('uses the configured HTTP client for deployment downloads', async () => {
  const archive = new TextEncoder().encode('proxy archive')
  extraction.executable = new TextEncoder().encode('proxy runtime')
  pin(TARGET, archive, extraction.executable)
  const fetcher = responseFetcher(archive)
  setMainHttpClient({ fetch: fetcher, proxySession: () => null })
  await materializeCachedNodeRuntime(TARGET, cacheRoot, {})
  expect(fetcher).toHaveBeenCalledOnce()
})

it('allows a progressing download to exceed two minutes', async () => {
  vi.useFakeTimers()
  const first = new TextEncoder().encode('first')
  const second = new TextEncoder().encode('second')
  extraction.executable = new TextEncoder().encode('slow runtime')
  pin(TARGET, Buffer.concat([first, second]), extraction.executable)
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
  const pending = materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(90_000)
  stream!.enqueue(first)
  await vi.waitFor(async () => {
    const runtimeDir = runtimeDirFor()
    const temporary = (await readdir(runtimeDir)).find((entry) => entry.startsWith('.download-'))!
    expect(
      (await stat(join(runtimeDir, temporary, NODE_RUNTIME_ASSETS[TARGET].archive))).size
    ).toBe(first.length)
  })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(signal?.aborted).toBe(false)
  stream!.enqueue(second)
  stream!.close()
  expect(await readFile(await pending)).toEqual(Buffer.from(extraction.executable))
})

it('retries a stalled body, then gives up and removes the unfinished download', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const cancel = vi.fn()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })))
  const pending = materializeCachedNodeRuntime(TARGET, cacheRoot, { fetcher })
  const rejected = expect(pending).rejects.toThrow('Node download stalled')
  const attempts = RUNTIME_ARCHIVE_RETRY_DELAYS_MS.length + 1
  // Real file I/O sits between the timers, so step the clock until each attempt shows.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetcher).toHaveBeenCalledTimes(attempt)
    })
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(cancel).toHaveBeenCalledTimes(attempt)
    })
  }
  await rejected
  expect(fetcher).toHaveBeenCalledTimes(attempts)
  expect(await readdir(runtimeDirFor())).toEqual([])
})
