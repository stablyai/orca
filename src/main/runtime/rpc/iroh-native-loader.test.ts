import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveIrohNativePath } from './iroh-native-loader'

const host = { platform: 'linux', arch: 'x64', libc: 'glibc' } as const
const immutableMain = `native-${'a'.repeat(64)}.node`
const slots = [
  ['linux', 'x64', 'glibc', 'iroh.linux-x64-gnu.node'],
  ['linux', 'arm64', 'glibc', 'iroh.linux-arm64-gnu.node'],
  ['linux', 'x64', 'musl', 'iroh.linux-x64-musl.node'],
  ['linux', 'arm64', 'musl', 'iroh.linux-arm64-musl.node'],
  ['darwin', 'arm64', 'none', 'iroh.darwin-arm64.node'],
  ['win32', 'x64', 'none', 'iroh.win32-x64-msvc.node'],
  ['win32', 'arm64', 'none', 'iroh.win32-arm64-msvc.node']
] as const
const directories: string[] = []

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'iroh-native-loader-'))
  directories.push(directory)
  return directory
}

function put(path: string, contents = 'native bytes after signing or Nix fixup'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return path
}

function sdk(root: string, main = 'index.js'): string {
  const directory = join(root, 'node_modules', '@number0', 'iroh')
  put(join(directory, 'package.json'), JSON.stringify({ name: '@number0/iroh', main }))
  put(join(directory, 'index.js'), "throw new Error('SDK JS must never execute')")
  return directory
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('exact patched Iroh native selection', () => {
  it.each(['src', 'out'])('selects the staged immutable source native from %s modules', (tree) => {
    const checkout = fixture()
    const directory = sdk(join(checkout, 'out'), `./${immutableMain}`)
    const native = put(join(directory, immutableMain))
    // A root npm install must never supersede the independently provisioned source stage.
    put(join(sdk(checkout), 'iroh.linux-x64-gnu.node'), 'stock npm bytes')
    const moduleFilename = join(checkout, tree, 'main', 'runtime', 'rpc', 'iroh-native-loader.js')
    expect(resolveIrohNativePath(moduleFilename, undefined, host)).toBe(realpathSync(native))
  })

  it('selects source staging from electron-vite main and chunk bundles', () => {
    const checkout = fixture()
    const native = put(join(sdk(join(checkout, 'out'), immutableMain), immutableMain))
    for (const entry of ['index.js', 'chunks/transport.js']) {
      expect(resolveIrohNativePath(join(checkout, 'out', 'main', entry), undefined, host)).toBe(
        realpathSync(native)
      )
    }
  })

  it.each(['index.js', 'chunks/transport.js'])(
    'prefers packaged Resources over a source stage included in app output (%s)',
    (entry) => {
      const resources = fixture()
      const output = join(resources, 'app.asar', 'out')
      put(join(sdk(output, immutableMain), immutableMain), 'a different-host source native')
      const native = put(join(sdk(resources), 'iroh.linux-x64-gnu.node'))
      expect(resolveIrohNativePath(join(output, 'main', entry), resources, host)).toBe(
        realpathSync(native)
      )
    }
  )

  it('uses the source stage when development Electron resources contain no SDK', () => {
    const checkout = fixture()
    const resources = fixture()
    const native = put(join(sdk(join(checkout, 'out'), immutableMain), immutableMain))
    expect(resolveIrohNativePath(join(checkout, 'out', 'main', 'index.js'), resources, host)).toBe(
      realpathSync(native)
    )
  })

  it.each(slots)(
    'selects the desktop native sibling for %s/%s/%s',
    (platform, arch, libc, filename) => {
      const resources = fixture()
      sdk(resources)
      const packageName = filename.replace(/^iroh\./, 'iroh-').replace(/\.node$/, '')
      const native = put(join(resources, 'node_modules', '@number0', packageName, filename))
      const moduleFilename = join(resources, 'app.asar', 'out', 'main', 'chunks', 'transport.js')
      expect(resolveIrohNativePath(moduleFilename, resources, { platform, arch, libc })).toBe(
        realpathSync(native)
      )
    }
  )

  it.each(slots)(
    'selects the daemon colocated native for %s/%s/%s',
    (platform, arch, libc, filename) => {
      const root = fixture()
      const native = put(join(sdk(root), filename))
      expect(
        resolveIrohNativePath(join(root, 'server.js'), undefined, { platform, arch, libc })
      ).toBe(realpathSync(native))
    }
  )

  it('prefers the exact colocated native over a sibling without running either JS main', () => {
    const root = fixture()
    const native = put(join(sdk(root, '../redirect.js'), 'iroh.linux-x64-gnu.node'))
    put(join(root, 'node_modules', '@number0', 'iroh-linux-x64-gnu', 'iroh.linux-x64-gnu.node'))
    expect(resolveIrohNativePath(join(root, 'server.js'), undefined, host)).toBe(
      realpathSync(native)
    )
  })

  it('ignores NAPI native-library and WASI environment redirection', () => {
    const root = fixture()
    const native = put(join(sdk(root), 'iroh.linux-x64-gnu.node'))
    const redirect = put(join(fixture(), 'redirect.node'))
    vi.stubEnv('NAPI_RS_NATIVE_LIBRARY_PATH', redirect)
    vi.stubEnv('NAPI_RS_FORCE_WASI', '1')
    vi.stubEnv('NAPI_RS_WASI_RUNTIME', 'redirect-runtime')
    expect(resolveIrohNativePath(join(root, 'server.js'), undefined, host)).toBe(
      realpathSync(native)
    )
  })

  it('does not fall back to another ABI or an environment native when the exact native is missing', () => {
    const root = fixture()
    const wrongAbi = put(join(sdk(root), 'iroh.linux-x64-gnu.node'))
    vi.stubEnv('NAPI_RS_NATIVE_LIBRARY_PATH', wrongAbi)
    expect(() =>
      resolveIrohNativePath(join(root, 'server.js'), undefined, { ...host, libc: 'musl' })
    ).toThrow()
  })

  it('never searches NODE_PATH or upward ancestors when the exact stage is missing', () => {
    const ancestor = fixture()
    put(join(sdk(ancestor), 'iroh.linux-x64-gnu.node'), 'ancestor stock npm bytes')
    const checkout = join(ancestor, 'checkout')
    const elsewhere = fixture()
    put(join(sdk(elsewhere), 'iroh.linux-x64-gnu.node'), 'NODE_PATH stock npm bytes')
    vi.stubEnv('NODE_PATH', join(elsewhere, 'node_modules'))
    expect(() =>
      resolveIrohNativePath(
        join(checkout, 'out', 'main', 'runtime', 'rpc', 'iroh-native-loader.js'),
        undefined,
        host
      )
    ).toThrow('Staged Iroh SDK is missing')
    expect(() =>
      resolveIrohNativePath(join(ancestor, 'daemon', 'server.js'), undefined, host)
    ).toThrow('Staged Iroh SDK is missing')
    expect(() =>
      resolveIrohNativePath(join(ancestor, 'chunks', 'server.js'), undefined, host)
    ).toThrow('Staged Iroh SDK is missing')
  })

  it('does not use checkout root npm when source staging is absent', () => {
    const checkout = fixture()
    put(join(sdk(checkout), 'iroh.linux-x64-gnu.node'), 'stock npm bytes')
    expect(() =>
      resolveIrohNativePath(join(checkout, 'out', 'main', 'index.js'), undefined, host)
    ).toThrow('Staged Iroh SDK is missing')
  })

  it.each(['index.js', '../stock.node', '/outside/native.node', 'native-not-a-sha256.node'])(
    'rejects an unprovisioned source package main (%s)',
    (main) => {
      const checkout = fixture()
      put(join(sdk(join(checkout, 'out'), main), 'iroh.linux-x64-gnu.node'))
      expect(() =>
        resolveIrohNativePath(
          join(checkout, 'src', 'main', 'runtime', 'rpc', 'iroh-native-loader.ts'),
          undefined,
          host
        )
      ).toThrow('Source Iroh SDK has not been provisioned')
    }
  )

  it('rejects a package symlink outside the app', () => {
    const root = fixture()
    const outside = sdk(fixture())
    put(join(outside, 'iroh.linux-x64-gnu.node'))
    const scope = join(root, 'node_modules', '@number0')
    mkdirSync(scope, { recursive: true })
    symlinkSync(outside, join(scope, 'iroh'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => resolveIrohNativePath(join(root, 'server.js'), undefined, host)).toThrow(
      'outside the application'
    )
  })

  it('rejects a native symlink outside the app', () => {
    const root = fixture()
    const directory = sdk(root)
    const outside = put(join(fixture(), 'outside.node'))
    symlinkSync(outside, join(directory, 'iroh.linux-x64-gnu.node'))
    expect(() => resolveIrohNativePath(join(root, 'server.js'), undefined, host)).toThrow(
      'outside the application'
    )
  })

  it('rejects a native filename symlinked to JavaScript even inside the app', () => {
    const root = fixture()
    const directory = sdk(root)
    const javascript = put(join(directory, 'redirect.js'), 'module.exports = {}')
    symlinkSync(javascript, join(directory, 'iroh.linux-x64-gnu.node'))
    expect(() => resolveIrohNativePath(join(root, 'server.js'), undefined, host)).toThrow(
      'must be a native addon'
    )
  })

  it.each([
    { platform: 'darwin', arch: 'x64', libc: 'none' },
    { platform: 'linux', arch: 'arm', libc: 'glibc' },
    { platform: 'linux', arch: 'x64', libc: 'none' },
    { platform: 'win32', arch: 'x64', libc: 'glibc' },
    { platform: 'freebsd', arch: 'x64', libc: 'none' }
  ] as const)(
    'never substitutes a supported native for an unsupported host (%s)',
    (unsupported) => {
      const root = fixture()
      put(join(sdk(root), 'iroh.linux-x64-gnu.node'))
      expect(() => resolveIrohNativePath(join(root, 'server.js'), undefined, unsupported)).toThrow(
        'Unsupported Iroh native target'
      )
    }
  )
})
