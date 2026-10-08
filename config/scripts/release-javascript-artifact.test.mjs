import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  javascriptInventory,
  packReleaseJavascript,
  releaseBuildIdentity,
  restoreReleaseJavascript
} from './release-javascript-artifact.mjs'

const directories = []
const configuration = {
  sourceSha: 'a'.repeat(40),
  version: '1.2.3-rc.4',
  packageManager: 'pnpm@12.8.1',
  identity: 'rc',
  diagnosticsTokenUrl: 'https://example.test/diagnostics',
  telemetryKeySha256: 'b'.repeat(64)
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-release-javascript-test-'))
  directories.push(root)
  for (const file of [
    'cli/index.js',
    'main/index.js',
    'preload/index.js',
    'renderer/index.html',
    'renderer/.vite/manifest.json',
    'web/web-index.html',
    'mobile-web/manifest.json',
    'package.json',
    'renderer/wasm/viewer.wasm',
    'main/index.js.map'
  ]) {
    const destination = join(root, 'out', file)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file === 'cli/index.js' ? '#!/usr/bin/env node\n' : file)
  }
  const artifactDir = join(root, '.build', 'artifact')
  return { root, artifactDir, configuration }
}

describe('release JavaScript transfer', () => {
  it('preserves hidden manifests, source maps and portable WASM while replacing stale outputs', () => {
    const options = fixture()
    const before = javascriptInventory(join(options.root, 'out'))
    packReleaseJavascript(options)
    writeFileSync(join(options.root, 'out', 'stale.js'), 'old')
    restoreReleaseJavascript(options)
    expect(javascriptInventory(join(options.root, 'out'))).toEqual(before)
  })

  it.each([
    'sourceSha',
    'version',
    'packageManager',
    'identity',
    'diagnosticsTokenUrl',
    'telemetryKeySha256'
  ])('rejects a different %s before replacing the current build', (field) => {
    const options = fixture()
    packReleaseJavascript(options)
    expect(() =>
      restoreReleaseJavascript({
        ...options,
        configuration: { ...configuration, [field]: 'different' }
      })
    ).toThrow('JavaScript build configuration differs')
    expect(readFileSync(join(options.root, 'out', 'main', 'index.js'), 'utf8')).toBe(
      'main/index.js'
    )
  })

  it('rejects a damaged archive before replacing the current build', () => {
    const options = fixture()
    packReleaseJavascript(options)
    writeFileSync(join(options.artifactDir, 'release-javascript.tar.gz'), 'damaged')
    expect(() => restoreReleaseJavascript(options)).toThrow('JavaScript archive differs')
    expect(readFileSync(join(options.root, 'out', 'main', 'index.js'), 'utf8')).toBe(
      'main/index.js'
    )
  })

  it('rejects a file inventory that no longer describes the archive', () => {
    const options = fixture()
    const manifest = packReleaseJavascript(options)
    manifest.files[0].sha256 = 'c'.repeat(64)
    writeFileSync(join(options.artifactDir, 'manifest.json'), JSON.stringify(manifest))
    expect(() => restoreReleaseJavascript(options)).toThrow('JavaScript file inventory differs')
  })

  it.each([
    'addon.node',
    'launcher.exe',
    'library.dll',
    'library.dylib',
    'library.so.1',
    'relay/relay.js'
  ])('keeps %s out of the portable artifact', (file) => {
    const options = fixture()
    const destination = join(options.root, 'out', file)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, 'host output')
    expect(() => packReleaseJavascript(options)).toThrow(/native binary|host output/)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects symlinks instead of following files outside the build',
    () => {
      const options = fixture()
      symlinkSync(
        join(options.root, 'out', 'main', 'index.js'),
        join(options.root, 'out', 'linked.js')
      )
      expect(() => packReleaseJavascript(options)).toThrow('contains a symlink')
    }
  )

  it('refuses incomplete build output', () => {
    const options = fixture()
    rmSync(join(options.root, 'out', 'preload', 'index.js'))
    expect(() => packReleaseJavascript(options)).toThrow(
      'Missing JavaScript output: preload/index.js'
    )
  })

  it('classifies stable and suffixed RC versions and rejects other tag families', () => {
    expect(releaseBuildIdentity('v1.2.3')).toBe('stable')
    expect(releaseBuildIdentity('v1.2.3-rc.4.perf')).toBe('rc')
    expect(() => releaseBuildIdentity('mobile-v1.2.3')).toThrow('Invalid desktop release tag')
  })
})
