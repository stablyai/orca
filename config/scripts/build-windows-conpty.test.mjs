import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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
import { stageWindowsRelayConpty } from './relay-conpty-packaging.mjs'
import { relayDaemonLaunchEnvironment } from './relay-daemon-launch-environment.mjs'
import { RELAY_WINDOWS_CONPTY_FILENAMES } from '../../src/shared/relay-artifacts.ts'
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

describe('Windows relay provider packaging', () => {
  it.each(['x64', 'arm64'])('stages the verified %s pair and metadata flat', async (arch) => {
    mkdirSync(output)
    await stageWindowsRelayConpty(`win32-${arch}`, output, { cacheDir, fetcher })
    expect(readdirSync(output).sort()).toEqual([...RELAY_WINDOWS_CONPTY_FILENAMES].sort())
    verifyConptyDirectory(output, arch)
    expect(readFileSync(join(output, 'conpty-LICENSE.txt'), 'utf8')).toContain('MIT License')
    expect(JSON.parse(readFileSync(join(output, 'conpty.json'), 'utf8'))).toMatchObject({
      arch,
      archiveSha256: fixture.archiveHash,
      files: fixture.files[arch]
    })
  })

  it.each(['conpty.dll', 'OpenConsole.exe'])(
    'rejects corrupt %s and removes staging',
    async (filename) => {
      mkdirSync(output)
      fixture.files.x64[filename] = digest('wrong binary')
      await expect(
        stageWindowsRelayConpty('win32-x64', output, { cacheDir, fetcher })
      ).rejects.toThrow('checksum mismatch')
      expect(readdirSync(output)).toEqual([])
    }
  )

  it('rejects a missing companion and removes staging', async () => {
    mkdirSync(output)
    const extract = vi.mocked(runProcessSync).getMockImplementation()
    vi.mocked(runProcessSync).mockImplementation((command) => {
      const result = extract(command)
      rmSync(join(command.args[1], 'build', 'native', 'runtimes', 'x64', 'OpenConsole.exe'))
      return result
    })
    await expect(
      stageWindowsRelayConpty('win32-x64', output, { cacheDir, fetcher })
    ).rejects.toThrow()
    expect(readdirSync(output)).toEqual([])
  })

  it.each(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'])(
    'does not touch %s packaging',
    async (platform) => {
      await stageWindowsRelayConpty(platform, output, { cacheDir, fetcher })
      expect(existsSync(output)).toBe(false)
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
})

describe('relay fault-harness provider environment', () => {
  it.each(['x64', 'arm64'])('selects verified adjacent %s binaries before launch', async (arch) => {
    mkdirSync(output)
    await stageWindowsRelayConpty(`win32-${arch}`, output, { cacheDir, fetcher })
    const entry = join(output, 'relay.js')
    writeFileSync(entry, '')
    const env = { BUN_CONPTY_LIBRARY: 'foreign.dll', ORCA_WATCHER_CHILD_PID_FILE: 'watcher.pid' }
    expect(relayDaemonLaunchEnvironment(entry, { platform: 'win32', arch, env })).toEqual({
      ...env,
      BUN_CONPTY_LIBRARY: join(realpathSync(output), 'conpty.dll')
    })
    expect(env.BUN_CONPTY_LIBRARY).toBe('foreign.dll')
    writeFileSync(join(output, 'OpenConsole.exe'), 'modified by signing')
    expect(() => relayDaemonLaunchEnvironment(entry, { platform: 'win32', arch, env })).toThrow(
      'checksum mismatch'
    )
    rmSync(join(output, 'OpenConsole.exe'))
    expect(() => relayDaemonLaunchEnvironment(entry, { platform: 'win32', arch, env })).toThrow()
  })

  it('leaves POSIX launches independent of Windows artifacts', () => {
    const env = { ORCA_WATCHER_CHILD_PID_FILE: 'watcher.pid' }
    expect(relayDaemonLaunchEnvironment('/missing/relay.js', { platform: 'linux', env })).toEqual(
      env
    )
  })

  it('wires verified environment into the fault harness daemon spawn', () => {
    const source = readFileSync(
      new URL('./relay-watcher-fault-harness.mjs', import.meta.url),
      'utf8'
    )
    expect(source).toContain(
      "import { relayDaemonLaunchEnvironment } from './relay-daemon-launch-environment.mjs'"
    )
    expect(source).toMatch(
      /env: relayDaemonLaunchEnvironment\(relayEntry, \{\s*env: \{ \.\.\.process.env, ORCA_WATCHER_CHILD_PID_FILE: pidFile \}/
    )
  })

  it('gates both relay providers after signing and before installer rebuild', () => {
    const source = readFileSync(
      new URL('../../.github/workflows/release-cut.yml', import.meta.url),
      'utf8'
    )
    const start = source.indexOf('      - name: Verify relay provider identity after signing')
    expect(start).toBeGreaterThan(
      source.indexOf('      - name: Restore signed inner binaries into unpacked app')
    )
    expect(start).toBeLessThan(source.indexOf('        id: rebuild-nsis-signed'))
    const step = source.slice(start, source.indexOf('      - name:', start + 1))
    expect(step).toContain(
      "for (const arch of ['x64', 'arm64']) verifyConptyDirectory('dist/win-unpacked/resources/relay/win32-' + arch, arch)"
    )
    expect(step).toContain('if ($LASTEXITCODE -ne 0) { throw')
    expect(step).not.toContain('continue-on-error')
    expect(step).not.toContain('restore-signed-inner.outcome')
  })
})

it('removes runtime injection flags without mutating controller environment', () => {
  const env = {
    NODE_OPTIONS: '--require=foreign',
    NODE_PATH: '/foreign',
    BUN_OPTIONS: 'foreign',
    BUN_INSPECT: '1',
    ELECTRON_RUN_AS_NODE: '1',
    PATH: '/keep',
    ORCA_BACKGROUND_LAUNCH: '1'
  }
  expect(relayDaemonLaunchEnvironment('/missing/relay.js', { platform: 'linux', env })).toEqual({
    PATH: '/keep',
    ORCA_BACKGROUND_LAUNCH: '1'
  })
  expect(env.NODE_OPTIONS).toBe('--require=foreign')
})
