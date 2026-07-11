import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWslRuntimeTransferPaths,
  decodeWslListOutput,
  INSTALL_SCRIPT,
  PROBE_BUNDLE_SENTINEL,
  parseInstallerResponse,
  parseRunningWslDistros,
  readWslWatcherBundleManifest,
  resolveWslWatcherBundlePath,
  WslWatcherCompatibilityError
} from './filesystem-watcher-wsl-runtime'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('managed WSL watcher runtime', () => {
  it('decodes the real UTF-16LE WSL list format without corrupting Unicode distro names', () => {
    const names = `Ubuntu\r\n${String.fromCodePoint(0x6d4b, 0x8bd5, 0x53d1, 0x884c, 0x7248)}\r\n`
    const encoded = Buffer.from(names, 'utf16le')

    expect(decodeWslListOutput(encoded)).toBe(names)
    expect(parseRunningWslDistros(encoded)).toEqual(['Ubuntu', '测试发行版'])
    expect(parseRunningWslDistros(Buffer.from('* Debian\r\n', 'utf8'))).toEqual(['Debian'])
  })

  it('retains compatibility with already-decoded ASCII/NUL output', () => {
    expect(parseRunningWslDistros('U\0b\0u\0n\0t\0u\0\r\0\n\0* Debian\r\n')).toEqual([
      'Ubuntu',
      'Debian'
    ])
  })

  it('requires a complete self-checking install and bounds lock/version retention', () => {
    expect(PROBE_BUNDLE_SENTINEL).toBe('-')
    expect(INSTALL_SCRIPT).toContain('runtime_is_valid()')
    expect(INSTALL_SCRIPT).toContain('test "$(cat "$complete"')
    expect(INSTALL_SCRIPT).toContain('= "$version"')
    expect(INSTALL_SCRIPT).toContain('"$install/node" "$install/host.js" --check')
    expect(INSTALL_SCRIPT).toContain('/proc/$owner/stat')
    expect(INSTALL_SCRIPT).toContain('lock/heartbeat')
    expect(INSTALL_SCRIPT).toContain('glibc >= 2.28')
    expect(INSTALL_SCRIPT).toContain('-mmin +180')
    expect(INSTALL_SCRIPT.indexOf('glibc >= 2.28')).toBeLessThan(
      INSTALL_SCRIPT.indexOf("printf 'install")
    )
    expect(INSTALL_SCRIPT).toContain('test "$retained" -lt 3')
    expect(INSTALL_SCRIPT).toContain('touch "$base/$version"')
    expect(INSTALL_SCRIPT).toContain('set -eu;')
    expect(INSTALL_SCRIPT).not.toContain('wslpath')
  })

  it('parses probe and completed installation responses strictly', () => {
    expect(parseInstallerResponse('install\nx64\n/home/me\n')).toEqual({
      kind: 'install',
      arch: 'x64',
      home: '/home/me'
    })
    expect(parseInstallerResponse('ready\n/home/me/node\n/home/me/host.js\n')).toEqual({
      kind: 'ready',
      nodePath: '/home/me/node',
      hostPath: '/home/me/host.js'
    })
    expect(() => parseInstallerResponse('ready\nrelative/node\nrelative/host\n')).toThrow()
  })

  it('stages through the WSL UNC boundary without a mounted Windows drive', () => {
    expect(createWslRuntimeTransferPaths('Ubuntu', '/home/me', 'a'.repeat(20), '42')).toEqual({
      linuxPath: `/home/me/.local/share/orca/wsl-watcher-transfer/${'a'.repeat(20)}-42`,
      windowsPath: `\\\\wsl.localhost\\Ubuntu\\home\\me\\.local\\share\\orca\\wsl-watcher-transfer\\${'a'.repeat(20)}-42`
    })
  })

  it('classifies missing or corrupt bundles as permanent compatibility failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-wsl-runtime-manifest-'))
    temporaryRoots.push(root)

    await expect(readWslWatcherBundleManifest(root)).rejects.toBeInstanceOf(
      WslWatcherCompatibilityError
    )
    await writeFile(join(root, 'manifest.json'), 'not json')
    await expect(readWslWatcherBundleManifest(root)).rejects.toBeInstanceOf(
      WslWatcherCompatibilityError
    )
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        protocol: 2,
        installLayout: 1,
        nodeVersion: '24.15.0',
        bundleVersion: 'a'.repeat(20)
      })
    )
    await expect(readWslWatcherBundleManifest(root)).rejects.toThrow(
      'Invalid managed WSL watcher manifest'
    )
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        protocol: 1,
        installLayout: 1,
        nodeVersion: '24.15.0',
        bundleVersion: 'a'.repeat(20)
      })
    )
    await expect(readWslWatcherBundleManifest(root)).resolves.toEqual({
      protocol: 1,
      installLayout: 1,
      nodeVersion: '24.15.0',
      bundleVersion: 'a'.repeat(20)
    })
  })

  it('fails closed for a missing packaged resource but resolves explicit development output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-wsl-runtime-path-'))
    temporaryRoots.push(root)
    const developmentBundle = join(root, 'out', 'wsl-watcher')
    await mkdir(developmentBundle, { recursive: true })

    expect(
      resolveWslWatcherBundlePath({
        packaged: false,
        cwd: root,
        moduleDir: join(root, 'out', 'main')
      })
    ).toBe(developmentBundle)
    const version = 'a'.repeat(20)
    const immutableBundle = join(root, 'out', 'wsl-watcher.builds', version)
    await mkdir(immutableBundle, { recursive: true })
    await writeFile(
      join(root, 'out', 'wsl-watcher.current.json'),
      JSON.stringify({
        protocol: 1,
        bundleVersion: version,
        relativePath: `wsl-watcher.builds/${version}`
      })
    )
    expect(
      resolveWslWatcherBundlePath({
        packaged: false,
        cwd: root,
        moduleDir: join(root, 'out', 'main')
      })
    ).toBe(immutableBundle)
    expect(() =>
      resolveWslWatcherBundlePath({
        packaged: true,
        resourcesPath: join(root, 'resources'),
        cwd: root,
        moduleDir: join(root, 'app.asar', 'out', 'main')
      })
    ).toThrow('Missing packaged WSL watcher resource')
  })
})
