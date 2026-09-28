import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ files: {}, archiveHash: '', archive: 'qualified archive' }))
vi.mock('../../src/shared/windows-conpty-release.ts', () => ({
  WINDOWS_CONPTY_VERSION: 'test-version',
  WINDOWS_CONPTY_ARCHIVE: {
    url: 'https://example.invalid/conpty.nupkg',
    get sha256() {
      return fixture.archiveHash
    }
  },
  WINDOWS_CONPTY_FILES: fixture.files
}))
vi.mock('./zip-extractor-command.mjs', () => ({
  getZipExtractorCommand: (archive, destination) => ({
    file: 'extract',
    args: [archive, destination]
  })
}))
vi.mock('./script-child-process.mjs', () => ({ runProcessSync: vi.fn() }))
import { runProcessSync } from './script-child-process.mjs'
import {
  downloadConptyArchive,
  materializeWindowsConpty,
  verifyConptyDirectory
} from './build-windows-conpty.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
let root
let cacheDir
let output
let fetcher
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conpty-build-test-'))
  cacheDir = join(root, 'cache')
  output = join(root, 'output')
  fixture.archiveHash = digest(fixture.archive)
  for (const arch of ['x64', 'arm64']) {
    fixture.files[arch] = {
      'conpty.dll': digest(`${arch} DLL`),
      'OpenConsole.exe': digest(`${arch} EXE`)
    }
  }
  fetcher = vi.fn(async () => new Response(fixture.archive))
  vi.mocked(runProcessSync).mockImplementation(({ args }) => {
    const dir = args[1]
    for (const arch of ['x64', 'arm64']) {
      const dllDir = join(dir, 'runtimes', `win-${arch}`, 'native')
      const exeDir = join(dir, 'build', 'native', 'runtimes', arch)
      mkdirSync(dllDir, { recursive: true })
      mkdirSync(exeDir, { recursive: true })
      writeFileSync(join(dllDir, 'conpty.dll'), `${arch} DLL`)
      writeFileSync(join(exeDir, 'OpenConsole.exe'), `${arch} EXE`)
    }
    writeFileSync(join(dir, 'Microsoft.Windows.Console.ConPTY.nuspec'), 'MIT package metadata')
    return { code: 0, stdout: '', stderr: '' }
  })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('independent ConPTY payload builder', () => {
  it.each(['x64', 'arm64'])(
    'publishes verified %s payload and preserves licensing',
    async (arch) => {
      await materializeWindowsConpty(arch, output, { cacheDir, fetcher })
      verifyConptyDirectory(output, arch)
      expect(readFileSync(join(output, 'LICENSE.txt'), 'utf8')).toContain('MIT License')
      expect(
        readFileSync(join(output, 'Microsoft.Windows.Console.ConPTY.nuspec'), 'utf8')
      ).toContain('MIT')
      expect(JSON.parse(readFileSync(join(output, 'conpty.json'), 'utf8'))).toMatchObject({
        arch,
        archiveSha256: fixture.archiveHash,
        files: fixture.files[arch]
      })
      expect(fetcher).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    }
  )

  it('reuses a verified cache without network access', async () => {
    await materializeWindowsConpty('x64', output, { cacheDir, fetcher })
    await materializeWindowsConpty('arm64', output, { cacheDir, fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('replaces a damaged cache instead of poisoning subsequent builds', async () => {
    mkdirSync(cacheDir)
    writeFileSync(join(cacheDir, 'conpty.nupkg'), 'damaged')
    await materializeWindowsConpty('x64', output, { cacheDir, fetcher })
    expect(readFileSync(join(cacheDir, 'conpty.nupkg'), 'utf8')).toBe(fixture.archive)
  })

  it('rejects a download hash mismatch before extraction or publication', async () => {
    fetcher.mockResolvedValue(new Response('wrong archive'))
    await expect(materializeWindowsConpty('x64', output, { cacheDir, fetcher })).rejects.toThrow(
      'archive checksum mismatch'
    )
    expect(runProcessSync).not.toHaveBeenCalled()
    expect(existsSync(output)).toBe(false)
    expect(existsSync(join(cacheDir, 'conpty.nupkg'))).toBe(false)
  })

  it('rejects a failed extraction before publishing files', async () => {
    vi.mocked(runProcessSync).mockReturnValue({ code: 1, stderr: 'extract failed' })
    await expect(materializeWindowsConpty('x64', output, { cacheDir, fetcher })).rejects.toThrow(
      'extraction failed'
    )
    expect(existsSync(output)).toBe(false)
  })

  it('rejects mismatched architecture bytes before publication', async () => {
    fixture.files.arm64['conpty.dll'] = digest('foreign DLL')
    await expect(materializeWindowsConpty('arm64', output, { cacheDir, fetcher })).rejects.toThrow(
      'checksum mismatch: arm64/conpty.dll'
    )
    expect(existsSync(output)).toBe(false)
  })

  it('rejects unsupported architectures before downloading', async () => {
    await expect(materializeWindowsConpty('x86', output, { cacheDir, fetcher })).rejects.toThrow(
      'Unsupported'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('bounds download memory and does not retain oversized archives', async () => {
    fetcher.mockResolvedValue(new Response(new Uint8Array(16 * 1024 * 1024 + 1)))
    const archive = join(root, 'oversize')
    await expect(downloadConptyArchive(archive, fetcher)).rejects.toThrow('size limit')
    expect(existsSync(archive)).toBe(false)
  })

  it('reports HTTP errors without caching the error body', async () => {
    fetcher.mockResolvedValue(new Response('missing', { status: 404 }))
    await expect(downloadConptyArchive(join(root, 'download'), fetcher)).rejects.toThrow('HTTP 404')
  })
})
