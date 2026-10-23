import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import {
  javascriptInventory,
  packReleaseJavascript,
  releaseBuildIdentity,
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
  it.each([
    ['1.2.3', 'stable'],
    ['1.2.3-rc.4.perf', 'rc']
  ])('preserves official build checks for %s', (version, identity) => {
    const { root, env } = configurationFixture(version)
    const result = releaseJavascriptConfiguration(root, { ...env, ORCA_BUILD_IDENTITY: identity })
    expect(result.identity).toBe(identity)
    expect(result.telemetryKeySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.sourceSha).toMatch(/^[a-f0-9]{40}$/)
  })

  it('requires explicit development mode and unset official constants', () => {
    const { root, env } = configurationFixture('0.0.0-adhoc.test')
    const devEnv = {
      ...env,
      ORCA_RELEASE_JAVASCRIPT_BUILD_IDENTITY: 'dev',
      ORCA_BUILD_IDENTITY: '',
      ORCA_POSTHOG_WRITE_KEY: ''
    }
    expect(releaseJavascriptConfiguration(root, devEnv)).toMatchObject({
      identity: 'dev',
      version: '0.0.0-adhoc.test',
      telemetryKeySha256: null,
      diagnosticsTokenUrl: env.ORCA_DIAGNOSTICS_TOKEN_URL
    })
    expect(() =>
      releaseJavascriptConfiguration(root, { ...devEnv, ORCA_BUILD_IDENTITY: 'stable' })
    ).toThrow('must not set an official build identity')
    expect(() =>
      releaseJavascriptConfiguration(root, { ...devEnv, ORCA_POSTHOG_WRITE_KEY: 'release-key' })
    ).toThrow('must not set a release telemetry key')
    expect(() =>
      releaseJavascriptConfiguration(root, {
        ...devEnv,
        ORCA_RELEASE_JAVASCRIPT_BUILD_IDENTITY: ''
      })
    ).toThrow('Invalid desktop release tag')
  })

  it('does not downgrade an official build when its identity or telemetry key is missing', () => {
    const { root, env } = configurationFixture()
    expect(() => releaseJavascriptConfiguration(root, { ...env, ORCA_BUILD_IDENTITY: '' })).toThrow(
      'Release build identity differs from version'
    )
    expect(() =>
      releaseJavascriptConfiguration(root, { ...env, ORCA_POSTHOG_WRITE_KEY: '' })
    ).toThrow('Missing release telemetry key')
    expect(() =>
      releaseJavascriptConfiguration(root, { ...env, ORCA_RELEASE_JAVASCRIPT_BUILD_IDENTITY: 'rc' })
    ).toThrow('Invalid JavaScript build identity')
    expect(() =>
      releaseJavascriptConfiguration(root, {
        ...env,
        ORCA_RELEASE_JAVASCRIPT_BUILD_IDENTITY: 'typo'
      })
    ).toThrow('Invalid JavaScript build identity')
  })

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
  it('restores development bundles and rejects them for an official build', () => {
    const options = fixture()
    const devConfiguration = { ...configuration, identity: 'dev', telemetryKeySha256: null }
    packReleaseJavascript({ ...options, configuration: devConfiguration })
    expect(() => restoreReleaseJavascript(options)).toThrow(
      'JavaScript build configuration differs'
    )
    expect(
      restoreReleaseJavascript({ ...options, configuration: devConfiguration }).configuration
    ).toEqual(devConfiguration)
  })

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
