import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import {
  javascriptInventory,
  packReleaseJavascript,
  releaseJavascriptConfiguration,
  restoreReleaseJavascript
} from './release-javascript-artifact.mjs'

const directories = []
const configuration = {
  sourceSha: 'a'.repeat(40),
  version: '1.2.3-rc.4',
  packageManager: 'pnpm@12.14.0',
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
    'renderer/.orca-web-client-files.json',
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

function configurationFixture(version = '1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'orca-javascript-configuration-test-'))
  directories.push(root)
  const hooks = join(root, 'empty-hooks')
  mkdirSync(hooks)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ version, packageManager: 'pnpm@12.14.0' })
  )
  for (const args of [
    ['init', '--quiet'],
    [
      '-c',
      'user.name=Build test',
      '-c',
      'user.email=build@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${hooks}`,
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'Build fixture'
    ]
  ]) {
    const result = runProcessSync({ program: 'git', args, cwd: root, timeoutMs: 10_000 })
    expect(result.code, result.stderr).toBe(0)
  }
  const env = {
    ORCA_BUILD_IDENTITY: 'stable',
    ORCA_DIAGNOSTICS_TOKEN_URL: 'https://example.test/diagnostics',
    ORCA_POSTHOG_WRITE_KEY: 'release-key'
  }
  return { root, env }
}

describe('release JavaScript configuration', () => {
  it('checks the source checkout and diagnostics endpoint in development mode', () => {
    const { root, env } = configurationFixture()
    const devEnv = {
      ...env,
      ORCA_RELEASE_JAVASCRIPT_BUILD_IDENTITY: 'dev',
      ORCA_BUILD_IDENTITY: '',
      ORCA_POSTHOG_WRITE_KEY: ''
    }
    expect(() =>
      releaseJavascriptConfiguration(root, {
        ...devEnv,
        ORCA_RELEASE_JAVASCRIPT_SOURCE_SHA: 'b'.repeat(40)
      })
    ).toThrow('Release checkout differs from bundle source')
    expect(() =>
      releaseJavascriptConfiguration(root, { ...devEnv, ORCA_DIAGNOSTICS_TOKEN_URL: '' })
    ).toThrow('Missing release diagnostics URL')
  })
})

describe('release JavaScript transfer', () => {
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
    writeFileSync(join(options.root, 'out', 'main', 'index.js'), 'current build')
    writeFileSync(join(options.root, 'out', 'current-only.js'), 'current only')
    const current = javascriptInventory(join(options.root, 'out'))
    manifest.files[0].sha256 = 'c'.repeat(64)
    writeFileSync(join(options.artifactDir, 'manifest.json'), JSON.stringify(manifest))
    expect(() => restoreReleaseJavascript(options)).toThrow('JavaScript file inventory differs')
    expect(javascriptInventory(join(options.root, 'out'))).toEqual(current)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects symlinks instead of following files outside the build',
    () => {
      const options = fixture()
      const outside = join(options.root, 'outside.js')
      writeFileSync(outside, 'outside the build')
      symlinkSync(outside, join(options.root, 'out', 'linked.js'))
      expect(() => packReleaseJavascript(options)).toThrow('contains a symlink')
    }
  )
})
