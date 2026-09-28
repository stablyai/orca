import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, realpath } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const { renameMock, environment } = vi.hoisted(() => ({
  renameMock: vi.fn(),
  environment: {
    appPath: '',
    localRoot: '',
    getAppPath() {
      return this.appPath
    },
    getVersion: () => 'test-version',
    getPath: () => '/unused-user-data'
  }
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  renameMock.mockImplementation(actual.rename)
  return { ...actual, rename: renameMock }
})
vi.mock('../../shared/windows-conpty-release', async () => {
  const { createHash } = await import('node:crypto')
  const hashes = {
    'conpty.dll': createHash('sha256').update('conpty fixture').digest('hex'),
    'OpenConsole.exe': createHash('sha256').update('console fixture').digest('hex')
  }
  return { WINDOWS_CONPTY_FILES: { x64: hashes, arm64: hashes } }
})
vi.mock('../../shared/app-environment', () => ({ getAppEnvironment: () => environment }))
import { resolveDaemonBunRuntime, resolveDesktopDaemonBunRuntime } from './daemon-bun-runtime'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(platform: 'darwin' | 'win32' = 'darwin') {
  const root = await mkdtemp(join(tmpdir(), 'daemon-bun-test-'))
  roots.push(root)
  const bundleDir = join(root, 'bundle')
  const runtimeDir = join(root, 'runtime')
  const windowsProcessTreeDir = join(root, 'native')
  for (const dir of [bundleDir, runtimeDir, windowsProcessTreeDir]) {
    await mkdir(dir)
  }
  if (platform === 'win32') {
    await mkdir(join(runtimeDir, 'conpty'))
    await writeFile(join(runtimeDir, 'conpty', 'conpty.dll'), 'conpty fixture')
    await writeFile(join(runtimeDir, 'conpty', 'OpenConsole.exe'), 'console fixture')
    await writeFile(join(runtimeDir, 'conpty', 'LICENSE.txt'), 'license fixture')
  }
  await writeFile(join(bundleDir, 'daemon-entry.js'), 'daemon')
  await writeFile(join(bundleDir, 'windows-bun-pty-gate-entry.js'), 'gate')
  await writeFile(join(windowsProcessTreeDir, 'package.json'), '{}')
  await mkdir(join(windowsProcessTreeDir, 'lib'))
  await mkdir(join(windowsProcessTreeDir, 'build', 'Release'), { recursive: true })
  await writeFile(join(windowsProcessTreeDir, 'lib', 'index.js'), 'native loader')
  await writeFile(
    join(windowsProcessTreeDir, 'build', 'Release', 'windows_process_tree.node'),
    'native'
  )
  await writeFile(join(runtimeDir, platform === 'win32' ? 'bun-runtime.exe' : 'bun-runtime'), 'bun')
  await writeFile(
    join(runtimeDir, 'runtime.json'),
    JSON.stringify({
      target: `${platform}-arm64`,
      version: ORCAD_BUN_VERSION,
      sha256: createHash('sha256').update('bun').digest('hex')
    })
  )
  return { root, bundleDir, runtimeDir, platform, arch: 'arm64', windowsProcessTreeDir }
}
describe('desktop Bun daemon runtime', () => {
  it('uses shipped runtime directly outside Windows relocation', async () => {
    const options = await fixture()
    expect(await resolveDaemonBunRuntime(options)).toEqual({
      execPath: join(options.runtimeDir, 'bun-runtime'),
      entryPath: join(options.bundleDir, 'daemon-entry.js')
    })
  })
  it('selects the verified source provider for unpackaged Windows launches', async () => {
    const options = await fixture('win32')
    const runtime = await resolveDaemonBunRuntime(options)
    expect(runtime.conptyLibraryPath).toBe(join(options.runtimeDir, 'conpty', 'conpty.dll'))
  })

  it('rejects corrupt runtime bytes before launching', async () => {
    const options = await fixture()
    await writeFile(join(options.runtimeDir, 'bun-runtime'), 'bad')
    await expect(resolveDaemonBunRuntime(options)).rejects.toThrow('identity mismatch')
  })
  it('copies Windows runtime and native closure outside install and repairs beside existing bytes', async () => {
    const fixtureOptions = await fixture('win32')
    const options = {
      ...fixtureOptions,
      relocationRoot: join(fixtureOptions.root, 'local', 'version')
    }
    const first = await resolveDaemonBunRuntime(options)
    expect(first.execPath.startsWith(options.relocationRoot)).toBe(true)
    expect(first.conptyLibraryPath).toBe(join(first.entryPath, '..', 'conpty', 'conpty.dll'))
    expect(await resolveDaemonBunRuntime(options)).toEqual(first)
    expect(await readFile(join(first.entryPath, '..', 'conpty', 'conpty.dll'), 'utf8')).toBe(
      'conpty fixture'
    )
    expect(await readFile(join(first.entryPath, '..', 'conpty', 'OpenConsole.exe'), 'utf8')).toBe(
      'console fixture'
    )
    expect(await readFile(join(first.entryPath, '..', 'conpty', 'LICENSE.txt'), 'utf8')).toBe(
      'license fixture'
    )
    expect(
      await readFile(
        join(
          first.entryPath,
          '..',
          'node_modules',
          '@vscode',
          'windows-process-tree',
          'package.json'
        ),
        'utf8'
      )
    ).toBe('{}')
    await writeFile(first.execPath, 'old-live-bytes')
    const second = await resolveDaemonBunRuntime(options)
    expect(second.execPath).not.toBe(first.execPath)
    expect(await readFile(first.execPath, 'utf8')).toBe('old-live-bytes')
    expect(await readFile(second.execPath, 'utf8')).toBe('bun')
  })
  it('retains process-table runtime siblings without copying native build intermediates', async () => {
    const options = await fixture('win32')
    await writeFile(join(options.windowsProcessTreeDir, 'lib', 'binding.js'), 'runtime sibling')
    await writeFile(
      join(options.windowsProcessTreeDir, 'build', 'Release', 'unused.pdb'),
      'symbols'
    )
    await mkdir(join(options.windowsProcessTreeDir, 'src'))
    await writeFile(join(options.windowsProcessTreeDir, 'src', 'unused.cc'), 'source')
    const relocated = await resolveDaemonBunRuntime({
      ...options,
      relocationRoot: join(options.root, 'cache')
    })
    const nativeRoot = join(
      relocated.entryPath,
      '..',
      'node_modules',
      '@vscode',
      'windows-process-tree'
    )
    expect(await readFile(join(nativeRoot, 'lib', 'binding.js'), 'utf8')).toBe('runtime sibling')
    await expect(
      readFile(join(nativeRoot, 'build', 'Release', 'unused.pdb'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(nativeRoot, 'src', 'unused.cc'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it.each(['conpty.dll', 'OpenConsole.exe'])(
    'rejects corrupt Windows provider %s before relocation',
    async (filename) => {
      const options = await fixture('win32')
      await writeFile(join(options.runtimeDir, 'conpty', filename), 'foreign provider')
      await expect(
        resolveDaemonBunRuntime({ ...options, relocationRoot: join(options.root, 'cache') })
      ).rejects.toThrow('ConPTY identity mismatch')
    }
  )

  it('rejects a Windows payload missing its native process table before relocation', async () => {
    const options = await fixture('win32')
    await rm(join(options.windowsProcessTreeDir, 'build', 'Release', 'windows_process_tree.node'))
    await expect(
      resolveDaemonBunRuntime({ ...options, relocationRoot: join(options.root, 'cache') })
    ).rejects.toThrow('Windows terminal process inspection artifact is missing')
  })

  it('repairs a corrupt gate without replacing a runtime directory used by another owner', async () => {
    const options = await fixture('win32')
    const relocated = { ...options, relocationRoot: join(options.root, 'cache') }
    const first = await resolveDaemonBunRuntime(relocated)
    const firstGate = join(first.entryPath, '..', 'windows-bun-pty-gate-entry.js')
    await writeFile(firstGate, 'foreign gate')
    const second = await resolveDaemonBunRuntime(relocated)
    expect(second.entryPath).not.toBe(first.entryPath)
    expect(await readFile(firstGate, 'utf8')).toBe('foreign gate')
    expect(
      await readFile(join(second.entryPath, '..', 'windows-bun-pty-gate-entry.js'), 'utf8')
    ).toBe('gate')
  })
  it('repairs a changed ConPTY beside the previous owner and keeps the full provider after install removal', async () => {
    const options = await fixture('win32')
    const relocated = { ...options, relocationRoot: join(options.root, 'cache') }
    const first = await resolveDaemonBunRuntime(relocated)
    const oldLibrary = join(first.entryPath, '..', 'conpty', 'conpty.dll')
    await writeFile(oldLibrary, 'old-owner bytes')
    const second = await resolveDaemonBunRuntime(relocated)
    expect(second.entryPath).not.toBe(first.entryPath)
    expect(await readFile(oldLibrary, 'utf8')).toBe('old-owner bytes')
    await rm(options.runtimeDir, { recursive: true })
    expect(await readFile(join(second.entryPath, '..', 'conpty', 'conpty.dll'), 'utf8')).toBe(
      'conpty fixture'
    )
    expect(await readFile(join(second.entryPath, '..', 'conpty', 'OpenConsole.exe'), 'utf8')).toBe(
      'console fixture'
    )
  })

  it('retries a transient Windows publication lock without bypassing relocation', async () => {
    const options = await fixture('win32')
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    renameMock.mockRejectedValueOnce(Object.assign(new Error('scanner lock'), { code: 'EPERM' }))
    const runtime = await resolveDaemonBunRuntime({
      ...options,
      relocationRoot: join(options.root, 'cache')
    })
    expect(runtime.execPath.startsWith(join(options.root, 'cache'))).toBe(true)
    expect(await readFile(runtime.execPath, 'utf8')).toBe('bun')
  })

  it('does not fall back to the install directory after permanent publication failure', async () => {
    const options = await fixture('win32')
    renameMock.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    await expect(
      resolveDaemonBunRuntime({
        ...options,
        relocationRoot: join(options.root, 'cache')
      })
    ).rejects.toThrow('disk full')
  })

  it('surfaces a persistent Windows publication lock after bounded retries', async () => {
    const options = await fixture('win32')
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const error = Object.assign(new Error('persistent scanner lock'), { code: 'EBUSY' })
    for (let attempt = 0; attempt < 6; attempt++) {
      renameMock.mockRejectedValueOnce(error)
    }
    const callsBefore = renameMock.mock.calls.length
    await expect(
      resolveDaemonBunRuntime({
        ...options,
        relocationRoot: join(options.root, 'cache')
      })
    ).rejects.toThrow('persistent scanner lock')
    expect(renameMock.mock.calls.length - callsBefore).toBe(6)
  })

  it('requires a managed local runtime root for packaged Windows', async () => {
    environment.appPath = join('/resources', 'app.asar')
    vi.stubGlobal('process', {
      ...process,
      platform: 'win32',
      versions: { ...process.versions, electron: '43.7.0' },
      env: { ...process.env, LOCALAPPDATA: '' }
    })
    await expect(resolveDesktopDaemonBunRuntime()).rejects.toThrow('LOCALAPPDATA is required')
  })

  it('keeps packaged Windows copies outside the legacy profile-scoped prune root', async () => {
    const options = await fixture('win32')
    const resources = join(options.root, 'resources')
    await mkdir(join(resources, 'node_modules', '@vscode'), { recursive: true })
    await rename(options.bundleDir, join(resources, 'terminal-daemon'))
    await rename(options.runtimeDir, join(resources, 'cli-runtime'))
    await rename(
      options.windowsProcessTreeDir,
      join(resources, 'node_modules', '@vscode', 'windows-process-tree')
    )
    environment.appPath = join(resources, 'app.asar')
    const localAppData = join(options.root, "O'Connor Local Data")
    vi.stubGlobal('process', {
      ...process,
      platform: 'win32',
      arch: 'arm64',
      versions: { ...process.versions, electron: '43.7.0' },
      env: { ...process.env, LOCALAPPDATA: localAppData }
    })
    const runtime = await resolveDesktopDaemonBunRuntime()
    expect(
      runtime?.execPath.startsWith(
        join(await realpath(localAppData), 'Orca', 'terminal-daemon-host', 'managed-v1')
      )
    ).toBe(true)
    expect(runtime?.execPath.startsWith(join(localAppData, 'Orca', 'daemon-host'))).toBe(false)
    runtime?.releaseLaunchPin?.()
  })
})
