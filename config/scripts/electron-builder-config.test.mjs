import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SRC_MAIN_DIR = join(REPO_ROOT, 'src', 'main')

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')
const FpmTarget = require('app-builder-lib/out/targets/FpmTarget').default
const electronBuilderNativeRebuild = require('./electron-builder-native-rebuild.cjs')

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
        '!{.claude,.grok,.agents,.codex}{,/**/*}',
        '!Casks{,/**/*}',
        '!{AGENTS.md,CLAUDE.md,DEVELOPING.md,bundle-size-progress.md,ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md,ORCHESTRATION_STRUCTURED_OUTPUT_DESIGN.md}',
        '!out/**/*.test.js',
        '!resources/plugins/launch/**'
      ])
    )
  })

  it('keeps local agent tooling out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const toolingPath of [
      '.grok/skills/review-and-submit/review-and-submit/SKILL.md',
      '.claude/skills/review-and-submit/review-and-submit/SKILL.md',
      '.agents/skills/electron/SKILL.md',
      '.codex/sessions/session.json'
    ]) {
      expect(packs(toolingPath)).toBe(false)
    }
    expect(packs('out/main/index.js')).toBe(true)
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

  // Why: out/electron-dev holds `pnpm dev`'s cached Electron.app copies (~270MB per branch).
  // CI never creates it, so only a local package would have hit this -- silently, as bulk.
  it('keeps cached dev Electron bundles out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const devBundlePath of [
      'out/electron-dev/1a2b3c4d5e6f/Orca: dev.app/Contents/MacOS/Electron',
      'out/electron-dev/1a2b3c4d5e6f/orca-dev-electron-app.json'
    ]) {
      expect(packs(devBundlePath)).toBe(false)
    }
    // The real build outputs sit beside it under out/ and must still ship.
    expect(packs('out/main/index.js')).toBe(true)
    expect(packs('out/renderer/index.html')).toBe(true)
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

  it('ships one macOS serve-sim package through the runtime closure', () => {
    const serveSimResources = electronBuilderConfig.mac.extraResources.filter((resource) =>
      [join('node_modules', 'serve-sim'), 'serve-sim'].includes(resource.to)
    )

    expect(serveSimResources).toEqual([
      expect.objectContaining({ to: join('node_modules', 'serve-sim') })
    ])
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

  it('ships the mac keyboard-layout helper in Contents/MacOS, not Resources', () => {
    expect(electronBuilderConfig.mac.extraFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/keyboard-layout-macos/.build/release/orca-keyboard-layout',
          to: 'MacOS/orca-keyboard-layout'
        })
      ])
    )
    expect(electronBuilderConfig.mac.extraResources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ to: 'orca-keyboard-layout' })])
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

  it('unpacks the replaceable WSL transcript filesystem process entry', async () => {
    const entryFilename = 'wsl-transcript-fs-process-entry.js'
    expect(electronBuilderConfig.asarUnpack).toContain(`out/main/${entryFilename}`)

    const viteConfig = await readFile(join(REPO_ROOT, 'electron.vite.config.ts'), 'utf8')
    expect(viteConfig).toMatch(new RegExp(`'${entryFilename.replace(/\.js$/, '')}':\\s*resolve\\(`))
  })

  // Why: the scanner service is forked with ELECTRON_RUN_AS_NODE, so asar is
  // invisible to it and a packed worker entry fails closed — dropping every
  // OpenCode session in packaged builds while dev stays green. Three legs must
  // agree on the filename, so all three are read rather than hardcoded.
  it('unpacks the OpenCode SQLite worker entry the scanner service forks', async () => {
    const spawnSource = await readFile(
      join(SRC_MAIN_DIR, 'ai-vault', 'session-scanner-opencode-sqlite-worker-spawn.ts'),
      'utf8'
    )
    const entryFilename = spawnSource.match(/WORKER_ENTRY_FILENAME = '([^']+)'/)?.[1]

    expect(entryFilename).toBeDefined()
    expect(electronBuilderConfig.asarUnpack).toContain(`out/main/${entryFilename}`)

    // Why: the emitted path comes from the rollup input key under
    // entryFileNames '[name].js', not from the source filename — renaming the
    // key alone would leave the other two legs agreeing on a file that no
    // longer exists.
    const viteConfig = await readFile(join(REPO_ROOT, 'electron.vite.config.ts'), 'utf8')
    expect(viteConfig).toContain("entryFileNames: '[name].js'")
    expect(viteConfig).toMatch(new RegExp(`'${entryFilename.replace(/\.js$/, '')}':\\s*resolve\\(`))
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

  it('uses the release artifact set as local Linux targets without changing existing names', () => {
    expect(electronBuilderConfig.linux.target).toEqual(['AppImage', 'deb', 'rpm'])
    expect(electronBuilderConfig.toolsets).toEqual({ appimage: '1.0.3' })
    expect(electronBuilderConfig.appImage.artifactName).toBe('orca-linux.${ext}')
    expect(electronBuilderConfig.deb.artifactName).toBe('orca-ide_${version}_${arch}.${ext}')
    expect(electronBuilderConfig.rpm).toMatchObject({
      packageName: 'orca-ide',
      artifactName: 'orca-ide-${version}.${arch}.${ext}'
    })
  })

  it('retains electron-builder runtime dependencies in deb and rpm packages', () => {
    for (const target of ['deb', 'rpm']) {
      const dependencies = electronBuilderConfig[target].depends
      expect(dependencies).toEqual(
        expect.arrayContaining(FpmTarget.prototype.getDefaultDepends(target))
      )
      expect(new Set(dependencies).size).toBe(dependencies.length)
    }
  })

  it('validates each AppImage before electron-builder publishes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-electron-builder-appimage-'))
    try {
      const appImage = join(root, 'orca-linux.AppImage')
      await writeFile(appImage, 'not an ELF')
      await chmod(appImage, 0o755)

      expect(() =>
        electronBuilderConfig.artifactBuildCompleted({ file: appImage, arch: 1 })
      ).toThrow(/ELF header is outside/)
      expect(() =>
        electronBuilderConfig.artifactBuildCompleted({ file: join(root, 'orca-ide.deb') })
      ).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  it('uses Orca native rebuild hook instead of electron-builder default rebuild', () => {
    expect(electronBuilderConfig.beforeBuild).toBe(electronBuilderNativeRebuild)
    expect(electronBuilderConfig.npmRebuild).toBe(true)
  })

  // Why: the .deb/.rpm update-recovery path keys entirely off the resources/package-type marker that
  // app-builder-lib's FpmTarget writes. If packaging silently stops shipping an fpm target, or adds
  // one the recovery path does not cover, getLinuxRootPackageType() returns null, autoInstallOnAppQuit
  // quietly goes back to true, and no unit test notices.
  describe('linux root-package update recovery contract', () => {
    // FpmTarget writes resources/package-type only for targets it supports auto-update for.
    const MARKER_TARGETS = new Set(['deb', 'rpm', 'pacman'])
    const RECOVERABLE_TARGETS = new Set(['deb', 'rpm'])
    const linuxTargets = electronBuilderConfig.linux.target.map((entry) =>
      typeof entry === 'string' ? entry : entry.target
    )

    it('still ships an AppImage plus at least one root-package target', () => {
      expect(linuxTargets).toContain('AppImage')
      expect(linuxTargets.some((target) => MARKER_TARGETS.has(target))).toBe(true)
    })

    it('ships no root-package target the recovery path cannot recover', () => {
      const unrecoverable = linuxTargets.filter(
        (target) => MARKER_TARGETS.has(target) && !RECOVERABLE_TARGETS.has(target)
      )
      expect(unrecoverable).toEqual([])
    })

    it('accepts exactly the markers electron-updater maps to a root-package updater', async () => {
      const source = await readFile(
        new URL('../../src/main/linux-update-package-type.ts', import.meta.url),
        'utf8'
      )
      for (const target of linuxTargets.filter((entry) => RECOVERABLE_TARGETS.has(entry))) {
        expect(source).toContain(`value === '${target}'`)
      }
    })

    it('keeps the pinned FpmTarget overwrite for configured deb and rpm artifacts', async () => {
      const source = await readFile(
        require.resolve('app-builder-lib/out/targets/FpmTarget'),
        'utf8'
      )

      expect(source).toContain('path.join(resourceDir, "package-type"), target')
      for (const target of RECOVERABLE_TARGETS) {
        expect(electronBuilderConfig[target]).toBeDefined()
      }
    })
  })
})
