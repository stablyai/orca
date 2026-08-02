import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')
const electronBuilderNativeRebuild = require('./electron-builder-native-rebuild.cjs')
const {
  createPackagedRuntimeNodeModuleResources,
  findAsarEntry,
  prunePackagedNodePty,
  prunePackagedParcelWatcher,
  prunePackagedSherpaOnnx,
  prunePackagedRuntimeTypeDeclarations,
  prunePackagedZodSources,
  verifyPackagedMainRuntimeDeps
} = require('../packaged-runtime-node-modules.cjs')

const MUTABLE_BUILD_ENV = [
  'ORCA_MAC_HOURLY',
  'ORCA_MAC_ADHOC',
  'ORCA_MAC_RELEASE',
  'ORCA_HOURLY_BUILD_VERSION',
  'ORCA_ADHOC_BUILD_VERSION',
  'ORCA_LOCAL_BUILD_VERSION'
]

/** Re-requires the config under a temporary env, then restores env and module cache. */
function withEnv(env, assert) {
  const configPath = require.resolve('../electron-builder.config.cjs')
  const original = Object.fromEntries(MUTABLE_BUILD_ENV.map((key) => [key, process.env[key]]))
  try {
    for (const key of MUTABLE_BUILD_ENV) {
      delete process.env[key]
    }
    Object.assign(process.env, env)
    delete require.cache[configPath]
    assert(require('../electron-builder.config.cjs'))
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    delete require.cache[configPath]
    require('../electron-builder.config.cjs')
  }
}

const withHourlyEnv = (assert) => withEnv({ ORCA_MAC_HOURLY: '1' }, assert)
const withAdhocEnv = (assert) => withEnv({ ORCA_MAC_ADHOC: '1' }, assert)

describe('electron-builder config', () => {
  it('keeps the packaged app identity aligned with local-build validation', () => {
    expect(electronBuilderConfig.appId).toBe(
      require('../../src/shared/local-build-compatibility-contract.json').appId
    )
  })

  it('excludes repo-only source trees from app.asar', () => {
    expect(electronBuilderConfig.files).toEqual(
      expect.arrayContaining([
        '!src{,/**/*}',
        '!config{,/**/*}',
        '!docs{,/**/*}',
        '!mobile{,/**/*}',
        '!native{,/**/*}',
        '!skills{,/**/*}',
        '!skill-guides{,/**/*}',
        '!skill-stubs{,/**/*}',
        '!resources/skills/**',
        '!tests{,/**/*}',
        '!examples{,/**/*}',
        '!pr-evidence{,/**/*}',
        '!Casks{,/**/*}',
        '!{AGENTS.md,CLAUDE.md,DEVELOPING.md,bundle-size-progress.md,ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md,ORCHESTRATION_STRUCTURED_OUTPUT_DESIGN.md}',
        '!out/**/*.test.js',
        '!resources/plugins/launch/**'
      ])
    )
  })

  // Why: `files` is an all-negation list, so electron-builder's default `**/*` packs
  // anything without an explicit `!` entry — examples/ landed without one and shipped
  // hostile-panel, the adversarial containment fixture, into 1.4.160-rc.3's app.asar.
  // Drive the real matcher: pinning the pattern string cannot prove it excludes the tree.
  it('keeps plugin authoring examples out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    // copyFiles() prepends this itself once the pattern list is all-negation.
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const authoringOnly of [
      'examples/plugins/hostile-panel/panel.html',
      'examples/plugins/hostile-panel/orca-plugin.json',
      'examples/plugins/hello-orca/main.mjs',
      'examples/plugins/hello-orca/orca-plugin.json'
    ]) {
      expect(packs(authoringOnly)).toBe(false)
    }
    // The negation stays anchored at the app root, so nested `examples` segments still ship.
    expect(packs('out/main/examples/index.js')).toBe(true)
  })

  it('keeps runtime resources available through extraResources', () => {
    const bundledPluginResources = expect.objectContaining({
      from: 'resources/plugins/launch',
      to: 'plugins/launch'
    })
    for (const platform of ['mac', 'linux', 'win']) {
      expect(electronBuilderConfig[platform].extraResources).toContainEqual({
        from: 'resources/skills',
        to: 'skills'
      })
      expect(electronBuilderConfig[platform].extraResources).toEqual(
        expect.arrayContaining([bundledPluginResources])
      )
    }
    expect(electronBuilderConfig.mac.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-macos/.build/release/Orca Computer Use.app',
          to: 'Orca Computer Use.app'
        })
      ])
    )
    expect(electronBuilderConfig.linux.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-linux/runtime.py',
          to: 'computer-use-linux/runtime.py'
        })
      ])
    )
    expect(electronBuilderConfig.win.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-windows/runtime.ps1',
          to: 'computer-use-windows/runtime.ps1'
        }),
        expect.objectContaining({
          from: 'native/windows-cli-launcher/.build/orca.exe',
          to: 'bin/orca.exe'
        })
      ])
    )
  })

  // Why: the Windows CLI shim is delivered only via extraResources to
  // resources/bin/orca.cmd (beside the native resources/bin/orca.exe). If the
  // source tree is also packed into app.asar it gets extracted by
  // asarUnpack:['resources/**'] to app.asar.unpacked/resources/win32/bin/orca.cmd,
  // a duplicate with no adjacent orca.exe that fails to launch (#7351).
  it('keeps the Windows CLI shim source tree out of app.asar', () => {
    expect(electronBuilderConfig.files).toEqual(
      expect.arrayContaining(['!resources/win32{,/**/*}'])
    )
    // Regression guard: the working shim must still ship via extraResources.
    expect(electronBuilderConfig.win.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'resources/win32/bin/orca.cmd',
          to: 'bin/orca.cmd'
        })
      ])
    )
  })

  // Why: on macOS 26 UNUserNotificationCenter aborts for executables launched
  // from Contents/Resources, so the helper must ship in Contents/MacOS (#7929).
  it('ships the mac notification-status helper in Contents/MacOS, not Resources', () => {
    expect(electronBuilderConfig.mac.extraFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/notification-status-macos/.build/release/orca-notification-status',
          to: 'MacOS/orca-notification-status'
        })
      ])
    )
    expect(electronBuilderConfig.mac.extraResources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ to: 'orca-notification-status' })])
    )
  })

  it('unpacks the compiled CommonJS boundary with CLI runtime files', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining([
        'out/package.json',
        'out/cli/**',
        'out/shared/**',
        'out/main/claude-accounts/keychain.js'
      ])
    )
  })

  // Why: without the unpacked entry the watcher client silently falls back to
  // in-process @parcel/watcher, reintroducing the #7547 main-process crash.
  it('unpacks the forked parcel-watcher process entry', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining(['out/main/parcel-watcher-process-entry.js'])
    )
  })

  it('keeps the worker-thread hang watchdog inside app.asar', () => {
    expect(electronBuilderConfig.asarUnpack).not.toContain(
      'out/main/main-thread-hang-watchdog-entry.js'
    )
  })

  it('uses the multi-size icon source for Linux packages', () => {
    expect(electronBuilderConfig.linux.icon).toBe('resources/build/icon.icns')
  })

  it('matches the Linux desktop entry to Electron window class', () => {
    expect(electronBuilderConfig.linux.desktop.entry.StartupWMClass).toBe('orca')
  })

  it('uses AppImage and deb as local Linux targets without changing existing artifact names', () => {
    expect(electronBuilderConfig.linux.target).toEqual(['AppImage', 'deb'])
    expect(electronBuilderConfig.appImage.artifactName).toBe('orca-linux.${ext}')
    expect(electronBuilderConfig.deb.artifactName).toBe('orca-ide_${version}_${arch}.${ext}')
    expect(electronBuilderConfig.rpm).toMatchObject({
      packageName: 'orca-ide',
      artifactName: 'orca-ide-${version}.${arch}.${ext}'
    })
  })

  it('uses a distinct AppImage name for Linux arm64 release uploads', () => {
    const configPath = require.resolve('../electron-builder.config.cjs')
    const original = process.env.ORCA_LINUX_ARM64_RELEASE
    try {
      delete require.cache[configPath]
      process.env.ORCA_LINUX_ARM64_RELEASE = '1'
      expect(require('../electron-builder.config.cjs').appImage.artifactName).toBe(
        'orca-linux-arm64.${ext}'
      )
    } finally {
      if (original === undefined) {
        delete process.env.ORCA_LINUX_ARM64_RELEASE
      } else {
        process.env.ORCA_LINUX_ARM64_RELEASE = original
      }
      delete require.cache[configPath]
      require('../electron-builder.config.cjs')
    }
  })

  it('overrides packaged semver only for local macOS builds', () => {
    const configPath = require.resolve('../electron-builder.config.cjs')
    const original = process.env.ORCA_LOCAL_BUILD_VERSION
    const originalMacRelease = process.env.ORCA_MAC_RELEASE
    try {
      delete require.cache[configPath]
      delete process.env.ORCA_MAC_RELEASE
      process.env.ORCA_LOCAL_BUILD_VERSION = '1.4.159-rc.0.local.123.abc'
      expect(require('../electron-builder.config.cjs').extraMetadata).toEqual({
        version: '1.4.159-rc.0.local.123.abc'
      })
    } finally {
      if (originalMacRelease === undefined) {
        delete process.env.ORCA_MAC_RELEASE
      } else {
        process.env.ORCA_MAC_RELEASE = originalMacRelease
      }
      if (original === undefined) {
        delete process.env.ORCA_LOCAL_BUILD_VERSION
      } else {
        process.env.ORCA_LOCAL_BUILD_VERSION = original
      }
      delete require.cache[configPath]
      require('../electron-builder.config.cjs')
    }
  })

  it('never applies local semver to release packaging', () => {
    const configPath = require.resolve('../electron-builder.config.cjs')
    const originalLocalVersion = process.env.ORCA_LOCAL_BUILD_VERSION
    const originalMacRelease = process.env.ORCA_MAC_RELEASE
    try {
      delete require.cache[configPath]
      process.env.ORCA_LOCAL_BUILD_VERSION = '1.4.159-local.123.abc'
      process.env.ORCA_MAC_RELEASE = '1'
      expect(require('../electron-builder.config.cjs').extraMetadata).toBeUndefined()
    } finally {
      if (originalLocalVersion === undefined) {
        delete process.env.ORCA_LOCAL_BUILD_VERSION
      } else {
        process.env.ORCA_LOCAL_BUILD_VERSION = originalLocalVersion
      }
      if (originalMacRelease === undefined) {
        delete process.env.ORCA_MAC_RELEASE
      } else {
        process.env.ORCA_MAC_RELEASE = originalMacRelease
      }
      delete require.cache[configPath]
      require('../electron-builder.config.cjs')
    }
  })

  // Why: Squirrel.Mac swaps the .app in place only when the replacement carries the
  // same bundle id and a valid Developer ID signature. A hourly built on the local
  // (com.stablyai.orca.local, ad-hoc) identity would be un-installable over a real
  // Orca — the whole point of the channel.
  it('builds hourly artifacts with the release signing identity', () => {
    withHourlyEnv((config) => {
      expect(config.mac.appId).toBeUndefined()
      expect(config.appId).toBe('com.stablyai.orca')
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.forceCodeSigning).toBe(true)
    })
  })

  // Why hourly must notarize despite the round trip: TCC anchors a notarized
  // Developer ID app's grants on identifier + team, not on its cdhash, so they
  // survive an update. An unnotarized hourly reads as a new client every build
  // and loses file access under Documents/Desktop/Downloads with no re-prompt.
  it('notarizes hourly builds like releases, and neither locally', () => {
    withHourlyEnv((config) => {
      expect(config.mac.notarize).toBe(true)
    })
    withEnv({ ORCA_MAC_RELEASE: '1' }, (config) => {
      expect(config.mac.notarize).toBe(true)
    })
    expect(electronBuilderConfig.mac.notarize).toBe(false)
  })

  // Why: the main repo's releases atom feed exposes only its 10 newest entries.
  // Publishing 24 hourly tags a day there would evict every stable/RC entry and
  // break update checks for every real user.
  it('publishes hourly builds to the separate hourly repo', () => {
    withHourlyEnv((config) => {
      expect(config.publish).toMatchObject({ repo: 'orca-hourly', releaseType: 'prerelease' })
    })
    expect(electronBuilderConfig.publish).toMatchObject({
      repo: 'orca',
      releaseType: 'release'
    })
  })

  it('stamps hourly packages with the hourly version', () => {
    withEnv(
      { ORCA_MAC_HOURLY: '1', ORCA_HOURLY_BUILD_VERSION: '1.4.160-hourly.202607281400' },
      (config) => {
        expect(config.extraMetadata).toEqual({ version: '1.4.160-hourly.202607281400' })
      }
    )
  })

  // Why adhoc carries the identical mac identity to hourly: it installs over a
  // real Orca through the same updater path, so the same signing and the same TCC
  // argument apply. Only the destination repo differs.
  it('builds adhoc artifacts with the release identity and its own repo', () => {
    withAdhocEnv((config) => {
      expect(config.appId).toBe('com.stablyai.orca')
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.mac.notarize).toBe(true)
      expect(config.forceCodeSigning).toBe(true)
      expect(config.publish).toMatchObject({ repo: 'orca-adhoc', releaseType: 'prerelease' })
    })
  })

  it('stamps adhoc packages with the adhoc version', () => {
    withEnv(
      { ORCA_MAC_ADHOC: '1', ORCA_ADHOC_BUILD_VERSION: '1.4.160-adhoc.20260728140533' },
      (config) => {
        expect(config.extraMetadata).toEqual({ version: '1.4.160-adhoc.20260728140533' })
      }
    )
  })

  // Why: the two dev channels share every packaging decision except where they
  // publish, so a future edit that collapses them must not also collapse the
  // repos — a branch build landing in orca-hourly would be offered to everyone
  // riding main.
  it('keeps the two dev channels on separate repos', () => {
    withHourlyEnv((hourly) => {
      withAdhocEnv((adhoc) => {
        expect(hourly.publish.repo).not.toBe(adhoc.publish.repo)
      })
    })
  })

  it('uses Orca native rebuild hook instead of electron-builder default rebuild', () => {
    expect(electronBuilderConfig.beforeBuild).toBe(electronBuilderNativeRebuild)
    expect(electronBuilderConfig.npmRebuild).toBe(true)
  })

  it('verifies packaged main runtime deps from Windows-style asar entries', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-deps-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')
      await mkdir(join(resourcesDir, 'node_modules', 'yaml'), { recursive: true })
      await mkdir(join(resourcesDir, 'node_modules', 'zod'), { recursive: true })

      const sources = new Map([
        ['out\\main\\index.js', 'const z = require("zod")'],
        ['out\\main\\agent-hooks\\managed-agent-hook-controls.js', 'const YAML = require("yaml")']
      ])
      const asar = {
        listPackage: () => [...sources.keys()].map((entry) => `\\${entry}`),
        extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('normalizes host-specific asar entry separators', () => {
    expect(findAsarEntry(['\\out\\main\\index.js'], 'out/main/index.js')).toBe(
      '\\out\\main\\index.js'
    )
    expect(findAsarEntry(['/out/main/index.js'], 'out/main/index.js')).toBe('/out/main/index.js')
  })

  it('prunes non-target node-pty prebuilds from packaged runtime resources', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-node-pty-prune-'))
    try {
      const prebuildsDir = join(resourcesDir, 'node_modules', 'node-pty', 'prebuilds')
      await mkdir(join(prebuildsDir, 'darwin-arm64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'darwin-x64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'linux-x64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'win32-x64'), { recursive: true })
      await mkdir(join(resourcesDir, 'node_modules', 'node-pty', 'third_party', 'conpty'), {
        recursive: true
      })
      await mkdir(join(resourcesDir, 'node_modules', 'node-pty', 'deps', 'winpty'), {
        recursive: true
      })

      prunePackagedNodePty(resourcesDir, 'darwin')

      await expect(readdir(prebuildsDir).then((entries) => entries.sort())).resolves.toEqual([
        'darwin-arm64',
        'darwin-x64'
      ])
      await expect(
        readdir(join(resourcesDir, 'node_modules', 'node-pty', 'third_party'))
      ).resolves.toEqual([])
      await expect(
        readdir(join(resourcesDir, 'node_modules', 'node-pty', 'deps'))
      ).resolves.toEqual([])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('copies the Windows node-pty ConPTY runtime beside the rebuilt addon', async () => {
    for (const arch of ['x64', 'arm64']) {
      const resourcesDir = await mkdtemp(join(tmpdir(), `orca-node-pty-conpty-${arch}-`))
      try {
        const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
        const releaseDir = join(nodePtyDir, 'build', 'Release')
        const conptyRoot = join(nodePtyDir, 'third_party', 'conpty', '0.1.0')
        await mkdir(releaseDir, { recursive: true })
        await writeFile(join(releaseDir, 'conpty.node'), 'native addon placeholder', 'utf8')
        for (const sourceArch of ['x64', 'arm64']) {
          const sourceDir = join(conptyRoot, `win10-${sourceArch}`)
          await mkdir(sourceDir, { recursive: true })
          await writeFile(join(sourceDir, 'conpty.dll'), `dll payload ${sourceArch}`, 'utf8')
          await writeFile(
            join(sourceDir, 'OpenConsole.exe'),
            `console payload ${sourceArch}`,
            'utf8'
          )
        }

        prunePackagedNodePty(resourcesDir, 'win32', arch)

        await expect(readFile(join(releaseDir, 'conpty', 'conpty.dll'), 'utf8')).resolves.toBe(
          `dll payload ${arch}`
        )
        await expect(readFile(join(releaseDir, 'conpty', 'OpenConsole.exe'), 'utf8')).resolves.toBe(
          `console payload ${arch}`
        )
      } finally {
        await rm(resourcesDir, { recursive: true, force: true })
      }
    }
  })

  it('includes @parcel/watcher in the packaged runtime closure', () => {
    // Why: the main process imports '@parcel/watcher' for filesystem change
    // events; if it is absent from the packaged closure the serve host silently
    // stops propagating file changes to clients (regression guard for #4851).
    const packaged = createPackagedRuntimeNodeModuleResources()
    const packagedTargets = packaged.map((resource) => resource.to)
    expect(packagedTargets).toContain(join('node_modules', '@parcel', 'watcher'))
    expect(
      packagedTargets.some((target) =>
        target.startsWith(join('node_modules', '@parcel', 'watcher-'))
      )
    ).toBe(true)
  })

  it('prunes non-target @parcel/watcher platform subpackages from packaged runtime resources', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-parcel-watcher-prune-'))
    try {
      const parcelDir = join(resourcesDir, 'node_modules', '@parcel')
      await mkdir(join(parcelDir, 'watcher'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-arm64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-x64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-x64-glibc'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-arm64-glibc'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-win32-x64'), { recursive: true })

      prunePackagedParcelWatcher(resourcesDir, 'linux')

      await expect(readdir(parcelDir).then((entries) => entries.sort())).resolves.toEqual([
        'watcher',
        'watcher-linux-arm64-glibc',
        'watcher-linux-x64-glibc'
      ])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('leaves unrelated @parcel/* runtime deps untouched when pruning the watcher', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-parcel-watcher-prune-unrelated-'))
    try {
      const parcelDir = join(resourcesDir, 'node_modules', '@parcel')
      await mkdir(join(parcelDir, 'watcher'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-arm64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-x64-glibc'), { recursive: true })
      // A hypothetical future @parcel/* runtime dep that is NOT a watcher subpackage.
      await mkdir(join(parcelDir, 'transformer-js'), { recursive: true })

      prunePackagedParcelWatcher(resourcesDir, 'linux')

      await expect(readdir(parcelDir).then((entries) => entries.sort())).resolves.toEqual([
        'transformer-js',
        'watcher',
        'watcher-linux-x64-glibc'
      ])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('prunes type declaration artifacts from packaged runtime node_modules', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-type-prune-'))
    try {
      const packageDir = join(resourcesDir, 'node_modules', 'example-package')
      await mkdir(join(packageDir, 'dist'), { recursive: true })
      await writeFile(join(packageDir, 'dist', 'index.cjs'), 'module.exports = {}', 'utf8')
      await writeFile(join(packageDir, 'dist', 'index.d.ts'), 'export type Value = string', 'utf8')
      await writeFile(join(packageDir, 'dist', 'index.d.cts'), 'export type Value = string', 'utf8')
      await writeFile(join(packageDir, 'dist', 'index.d.mts.map'), '{}', 'utf8')

      prunePackagedRuntimeTypeDeclarations(resourcesDir)

      await expect(readdir(join(packageDir, 'dist'))).resolves.toEqual(['index.cjs'])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('prunes duplicate darwin sherpa-onnx runtime dylib aliases', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-sherpa-prune-'))
    try {
      const packageDir = join(resourcesDir, 'node_modules', 'sherpa-onnx-darwin-arm64')
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'sherpa-onnx.node'), '', 'utf8')
      await writeFile(join(packageDir, 'libonnxruntime.1.23.2.dylib'), '', 'utf8')
      await writeFile(join(packageDir, 'libonnxruntime.dylib'), '', 'utf8')

      prunePackagedSherpaOnnx(resourcesDir, 'darwin')

      await expect(readdir(packageDir).then((entries) => entries.sort())).resolves.toEqual([
        'libonnxruntime.1.23.2.dylib',
        'sherpa-onnx.node'
      ])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('prunes zod TypeScript sources from packaged runtime resources', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-zod-prune-'))
    try {
      const packageDir = join(resourcesDir, 'node_modules', 'zod')
      await mkdir(join(packageDir, 'src'), { recursive: true })
      await writeFile(join(packageDir, 'index.cjs'), 'module.exports = {}', 'utf8')
      await writeFile(join(packageDir, 'src', 'index.ts'), 'export const value = true', 'utf8')

      prunePackagedZodSources(resourcesDir)

      await expect(readdir(packageDir)).resolves.toEqual(['index.cjs'])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('fails when the packaged resources directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-electron-builder-config-'))
    try {
      await expect(
        electronBuilderConfig.afterPack({
          appOutDir: root,
          electronPlatformName: 'win32'
        })
      ).rejects.toThrow(/Missing packaged resources directory/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'marks packaged Unix CLI launchers executable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-electron-builder-config-'))
      try {
        const resourcesDir = join(root, 'linux-unpacked', 'resources')
        const launcherPath = join(resourcesDir, 'bin', 'orca-ide')
        await mkdir(join(resourcesDir, 'bin'), { recursive: true })
        await cp(
          join(process.cwd(), 'resources', 'plugins', 'launch'),
          join(resourcesDir, 'plugins', 'launch'),
          { recursive: true }
        )
        await mkdir(join(resourcesDir, 'node_modules', 'zod', 'src'), { recursive: true })
        // Why: afterPack now fails hard when the unpacked daemon entry is
        // missing, so the fixture must carry one like a real package layout.
        const unpackedMainDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main')
        await mkdir(unpackedMainDir, { recursive: true })
        await writeFile(
          join(unpackedMainDir, 'daemon-entry.js'),
          'console.error("Usage: daemon-entry <socket>"); process.exit(1)\n',
          'utf8'
        )
        const unpackedCliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
        await mkdir(join(unpackedCliDir, 'handlers'), { recursive: true })
        await writeFile(join(unpackedCliDir, 'handlers', 'skills.js'), '', 'utf8')
        await writeFile(
          join(unpackedCliDir, 'index.js'),
          [
            'const args = process.argv.slice(2)',
            "if (args[1] === 'list') console.log(JSON.stringify({ topics: [{ name: 'orca-cli' }, { name: 'computer-use' }] }))",
            "else if (args[1] === 'get') console.log(`---\\nname: ${args[2]}\\n---`)",
            'else console.log(JSON.stringify({ executed: false }))'
          ].join('\n'),
          'utf8'
        )
        await writeFile(launcherPath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o644 })

        await electronBuilderConfig.afterPack({
          appOutDir: join(root, 'linux-unpacked'),
          electronPlatformName: 'linux'
        })

        expect((await stat(launcherPath)).mode & 0o111).not.toBe(0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
