import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_BUN_RUNTIME_FILENAME } from '../../shared/orcad-artifacts'
import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import { materializeCachedOrcadBunRuntime } from './orcad-bun-runtime-materializer'

const extraction = vi.hoisted(() => ({ executable: new Uint8Array(), executableName: 'bun' }))

vi.mock('extract-zip', () => ({
  default: vi.fn(async (_archive: string, options: { dir: string }) => {
    const extracted = join(options.dir, 'bun-linux-x64')
    await mkdir(extracted, { recursive: true })
    await writeFile(join(extracted, extraction.executableName), extraction.executable)
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
    const runtimeDir = join(cacheRoot, 'bun', 'v1.4.0', target)
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
    const runtimeDir = join(cacheRoot, 'bun', 'v1.4.0', TARGET)
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
    expect((await stat(runtimePath)).mode & 0o111).toBe(0o111)
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/bun-v1.4.0/bun-linux-x64.zip'),
      expect.objectContaining({ redirect: 'follow' })
    )
    expect((await readdir(join(cacheRoot, 'bun', 'v1.4.0', TARGET))).sort()).toEqual([
      ORCAD_BUN_RUNTIME_FILENAME
    ])
  })

  it('refuses an oversized declared archive before reading its body', async () => {
    const fetcher = responseFetcher(new Uint8Array([1]), 200 * 1024 * 1024 + 1)

    await expect(materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })).rejects.toThrow(
      'Bun download exceeded the archive size limit'
    )
    await expect(
      access(join(cacheRoot, 'bun', 'v1.4.0', TARGET, ORCAD_BUN_RUNTIME_FILENAME))
    ).rejects.toThrow()
    expect(await readdir(join(cacheRoot, 'bun', 'v1.4.0', TARGET))).toEqual([])
  })

  it('removes temporary data after an archive checksum mismatch', async () => {
    const archive = new TextEncoder().encode('tampered archive')
    const fetcher = responseFetcher(archive)

    await expect(materializeCachedOrcadBunRuntime(TARGET, cacheRoot, { fetcher })).rejects.toThrow(
      'Bun archive checksum mismatch'
    )
    expect(await readdir(join(cacheRoot, 'bun', 'v1.4.0', TARGET))).toEqual([])
  })
})
