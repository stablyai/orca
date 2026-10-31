import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeMobileWebBundleFixtureTree } from './mobile-web-bundle-fixture-tree.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('electron-builder config', () => {
  it('excludes repo-only source trees from app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })
    for (const sourcePath of [
      'src/main/index.ts',
      'config/electron-builder.config.cjs',
      'cloud/apps/relay/index.ts',
      'docs/README.md',
      'mobile/app/index.tsx',
      'native/windows-cli-launcher/main.cpp',
      'skills/release/SKILL.md',
      'skill-guides/release.md',
      'skill-stubs/release.md',
      'resources/skills/current-manifest.json',
      'tests/e2e/example.spec.ts',
      'examples/example.ts',
      'pr-evidence/example.png',
      'Casks/orca.rb',
      'AGENTS.md',
      'out/main/workspace.test.js',
      'resources/plugins/launch/example.ts'
    ]) {
      expect(packs(sourcePath), sourcePath).toBe(false)
    }
    expect(packs('out/main/index.js')).toBe(true)
    expect(packs('node_modules/example/docs/index.js')).toBe(true)
    expect(packs('node_modules/example/src/index.js')).toBe(true)
  })

  it('keeps release build staging out of app.asar while preserving runtime output', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    expect(isPacked(join('/app', '.build'), { isDirectory: () => true })).toBe(false)
    for (const stagingPath of [
      '.build/release-javascript/release-javascript.tar.gz',
      '.build/release-javascript/manifest.json',
      '.build/release-javascript-123/out/main/index.js'
    ]) {
      expect(isPacked(join('/app', stagingPath), { isDirectory: () => false })).toBe(false)
    }
    for (const runtimePath of [
      'out/main/index.js',
      'out/cli/index.js',
      'out/renderer/index.html'
    ]) {
      expect(isPacked(join('/app', runtimePath), { isDirectory: () => false })).toBe(true)
    }
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
    expect(packs('out/web/web-index.html')).toBe(false)
    expect(packs('out/web/assets/shared.js')).toBe(false)
    expect(packs('out/renderer/web-index.html')).toBe(true)
    expect(packs('out/renderer/.orca-web-client-files.json')).toBe(true)
  })

  it.each(['file', 'directory'])('keeps a root notes %s out of app.asar', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-packaging-notes-'))
    const source = join(root, 'app')
    const destination = join(root, 'selected')
    const runtimePaths = [
      'package.json',
      'out/main/index.js',
      'out/renderer/index.html',
      'out/cli/index.js',
      'out/shared/index.js',
      'out/main/notes/index.js',
      'out/renderer/assets/notes/help.md',
      'resources/notes/help.md',
      'notes.txt'
    ]
    const notesPaths =
      kind === 'file'
        ? ['notes']
        : [
            'notes/build.log',
            'notes/installed-orca-backup/Orca.exe',
            'notes/installed-orca-backup/resources/app.asar',
            'notes/orca-windows-setup.exe',
            'notes/.recovery/state.json'
          ]
    try {
      for (const fixturePath of [...runtimePaths, ...notesPaths]) {
        const file = join(source, fixturePath)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, 'synthetic fixture\n')
      }
      if (kind === 'directory') {
        await mkdir(join(source, 'notes', 'empty'))
      }
      const matcher = new FileMatcher(
        source,
        destination,
        (value) => value,
        electronBuilderConfig.files
      )
      // copyFiles adds the default include and prunes excluded directories during traversal.
      await copyFiles([matcher])
      for (const runtimePath of runtimePaths) {
        expect(await readFile(join(destination, runtimePath), 'utf8')).toBe('synthetic fixture\n')
      }
      const isPacked = matcher.createFilter()
      for (const notesPath of new Set(['notes', ...notesPaths])) {
        const file = join(source, notesPath)
        expect(isPacked(file, await lstat(file)), notesPath).toBe(false)
      }
      expect(existsSync(join(destination, 'notes'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // All-negation lists implicitly include **/*; missing examples exclusion shipped hostile-panel in 1.4.160-rc.3. Exercise real matcher, not pattern spelling.
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

  // CI never creates ~270MB/branch out/electron-dev caches; only local packages exposed this bloat.
  it('keeps cached dev Electron bundles and Vite dependencies out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const devBundlePath of [
      'out/electron-dev/1a2b3c4d5e6f/Orca: dev.app/Contents/MacOS/Electron',
      'out/electron-dev/1a2b3c4d5e6f/orca-dev-electron-app.json',
      '.cache/vite/renderer/deps/react.js',
      '.cache/vite/web/deps/react.js',
      '.cache/vite.lock/owner'
    ]) {
      expect(packs(devBundlePath)).toBe(false)
    }
    // The real build outputs sit beside it under out/ and must still ship.
    expect(packs('out/main/index.js')).toBe(true)
    expect(packs('out/renderer/index.html')).toBe(true)
  })

  // Duplicated relay.js added 14MB to asar and AV quarantine gutted the entire archive (#20966); packaged app uses resources/relay.
  it('keeps the relay bundles out of app.asar and ships them only through extraResources', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const relayPath of [
      'out/relay/linux-x64/relay.js',
      'out/relay/win32-x64/relay.js',
      'out/relay/darwin-arm64/relay-watcher.js',
      'out/relay/wsl/wsl-agent-hook-relay.js'
    ]) {
      expect(packs(relayPath)).toBe(false)
    }

    for (const platform of ['mac', 'linux', 'win']) {
      expect(electronBuilderConfig[platform].extraResources).toContainEqual({
        from: 'out/relay',
        to: 'relay'
      })
    }
  })

  // Bundled agent-browser answered "No skills found" because only its binary shipped (#17705).
  const hostBuilderPlatform = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]
  it.runIf(hostBuilderPlatform)(
    'ships the agent-browser skill catalog the packaged binary resolves',
    async () => {
      const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-agent-browser-'))
      try {
        const resources = electronBuilderConfig[hostBuilderPlatform].extraResources.filter(
          (entry) => entry.from.startsWith('node_modules/agent-browser/') || entry.to === 'skills'
        )
        const expand = (value) => value.replace('${arch}', process.arch)
        await copyFiles(
          resources.map(
            (entry) =>
              new FileMatcher(
                join(REPO_ROOT, expand(entry.from)),
                join(resourcesDir, expand(entry.to)),
                (value) => value
              )
          )
        )
        const binary = resources.find((entry) => entry.to.startsWith('agent-browser-'))
        expect(binary).toBeDefined()
        const binaryPath = join(resourcesDir, expand(binary.to))
        // afterPack restores the executable bit; upstream tarball modes vary.
        await chmod(binaryPath, 0o755)
        const { AGENT_BROWSER_SKILLS_DIR: _override, ...env } = process.env
        const { stdout } = await promisify(execFile)(binaryPath, ['skills', 'get', 'core'], {
          env,
          windowsHide: true
        })
        expect(stdout).toContain('name: core')
      } finally {
        await rm(resourcesDir, { recursive: true, force: true })
      }
    }
  )

  it.each(['mac', 'linux'])(
    'loads Codex TOML parsing after %s runtime pruning',
    async (platform) => {
      const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-codex-toml-'))
      try {
        const resource = electronBuilderConfig[platform].extraResources.find(
          (entry) => entry.to === join('node_modules', 'smol-toml')
        )
        expect(resource).toBeDefined()
        await copyFiles([
          new FileMatcher(resource.from, join(resourcesDir, resource.to), (value) => value)
        ])
        require('../packaged-runtime-node-modules.cjs').prunePackagedRuntimeNodeModules(
          resourcesDir,
          platform === 'mac' ? 'darwin' : 'linux',
          process.arch
        )
        const stagedRequire = createRequire(join(resourcesDir, 'out', 'main', 'codex', 'trust.cjs'))
        expect(await realpath(stagedRequire.resolve('smol-toml'))).toBe(
          await realpath(join(resourcesDir, resource.to, 'dist', 'index.cjs'))
        )
        const { parse } = stagedRequire('smol-toml')
        expect(parse('[projects."/workspace"]\ntrust_level = "trusted"\n')).toEqual({
          projects: { '/workspace': { trust_level: 'trusted' } }
        })
      } finally {
        await rm(resourcesDir, { recursive: true, force: true })
      }
    }
  )

  // Why: serve-sim's addon is a Mach-O, and Windows signing rejects every *.node that is not PE.

  // Source shim unpacked under resources/win32/bin lacks adjacent orca.exe (#7351); only extraResources/bin copy works.

  // macOS 26 UNUserNotificationCenter aborts helpers launched from Resources; ship under MacOS (#7929).

  // Missing unpacked entry silently restores in-process watcher and #7547 main crashes.

  // CLI Node mode cannot read asar; packed entry sends orca serve to Electron (#27307).
  it('unpacks the orcad serve-selection entry the CLI runs', async () => {
    const sharedSource = await readFile(
      join(REPO_ROOT, 'src', 'shared', 'orcad-local-serve-selection.ts'),
      'utf8'
    )
    const entryName = sharedSource.match(/ORCAD_LOCAL_SERVE_SELECTION_ENTRY = '([^']+)'/)?.[1]
    expect(entryName).toBeDefined()

    const matcher = new FileMatcher(
      '/app',
      '/dest',
      (value) => value,
      electronBuilderConfig.asarUnpack
    )
    const isUnpacked = matcher.createFilter()
    expect(
      isUnpacked(join('/app', 'out', 'main', `${entryName}.js`), { isDirectory: () => false })
    ).toBe(true)
  })

  // Swept one-time /tmp asar extracts cause web-client 500s and phone bundle failures until restart (#27976).
  it('unpacks the web and mobile bundles a host serves by opening their files', () => {
    const matcher = new FileMatcher(
      '/app',
      '/dest',
      (value) => value,
      electronBuilderConfig.asarUnpack
    )
    const isUnpacked = matcher.createFilter()
    for (const webPath of [
      'out/renderer/web-index.html',
      'out/renderer/assets/index-abc123.js',
      'out/renderer/.orca-web-client-files.json',
      'out/mobile-web/manifest.json',
      'out/mobile-web/assets/index-abc123.js'
    ]) {
      expect(isUnpacked(join('/app', webPath), { isDirectory: () => false })).toBe(true)
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
})

describe('arch-aware packaging guard', () => {
  // electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3.
  const HOST_ARCH = process.arch === 'arm64' ? 3 : 1
  const OTHER_ARCH = process.arch === 'arm64' ? 1 : 3
  const OTHER_ARCH_NAME = process.arch === 'arm64' ? 'x64' : 'arm64'
  const SHERPA_PLATFORM = process.platform === 'win32' ? 'win' : process.platform
  const otherSherpa = `sherpa-onnx-${SHERPA_PLATFORM}-${OTHER_ARCH_NAME}`

  // Native tests need valid mobile bundle for beforePack; use temp build, leaving bundle verification to its own suite.
  let scratch
  let bundleDir
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'orca-electron-builder-guard-'))
    bundleDir = join(scratch, 'mobile-web')
    await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  const packHost = (arch) =>
    electronBuilderConfig.beforePack(
      { electronPlatformName: process.platform, arch },
      bundleDir,
      () => undefined
    )

  it('allows packaging the host platform and architecture', () => {
    expect(() => packHost(HOST_ARCH)).not.toThrow()
  })

  it('refuses to package a dark layout-owner build', () => {
    const previous = process.env.ORCA_LAYOUT_OWNER
    process.env.ORCA_LAYOUT_OWNER = 'main'
    try {
      expect(() => packHost(HOST_ARCH)).toThrow('ORCA_LAYOUT_OWNER=main')
    } finally {
      if (previous === undefined) {
        delete process.env.ORCA_LAYOUT_OWNER
      } else {
        process.env.ORCA_LAYOUT_OWNER = previous
      }
    }
  })

  it('refuses to package an orcad template marked by a dark test build', async () => {
    const templateDir = join(scratch, 'orcad-template')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'ORCA_LAYOUT_OWNER_MAIN'), 'dark\n')
    try {
      expect(() =>
        electronBuilderConfig.beforePack(
          { electronPlatformName: process.platform, arch: HOST_ARCH },
          bundleDir,
          () => undefined,
          templateDir
        )
      ).toThrow(`${templateDir} holds an ORCA_LAYOUT_OWNER=main build`)
    } finally {
      await rm(templateDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'requires the other architecture natives to be installed',
    () => {
      const otherSherpaInstalled = existsSync(
        join(REPO_ROOT, 'node_modules', otherSherpa, 'package.json')
      )
      const otherSherpaExpected = Object.hasOwn(
        require('../../package.json').optionalDependencies,
        otherSherpa
      )
      if (otherSherpaExpected && !otherSherpaInstalled) {
        expect(() => packHost(OTHER_ARCH)).toThrow(otherSherpa)
        expect(() => packHost(OTHER_ARCH)).toThrow('pnpm install:release')
      } else {
        expect(() => packHost(OTHER_ARCH)).not.toThrow()
      }
    }
  )

  // The host's own build is the foreign-arch case: a Windows checkout compiles these for its CPU only.
  it.runIf(process.platform === 'win32')(
    'refuses a Windows workspace addon built for another architecture',
    () => {
      for (const binary of ['orca_windows_registry.node', 'orca_windows_security.node']) {
        expect(() => packHost(OTHER_ARCH)).toThrow(`${binary} for ${OTHER_ARCH_NAME}`)
      }
    }
  )

  it('requires installed Windows addons for Windows packaging', () => {
    const windowsAddon = electronBuilderConfig.win.extraResources.some(
      (resource) => resource.to === join('node_modules', '@vscode', 'windows-process-tree')
    )
    const packWindows = () =>
      electronBuilderConfig.beforePack({ electronPlatformName: 'win32', arch: 1 }, bundleDir)
    if (process.platform === 'win32' || windowsAddon) {
      expect(packWindows).not.toThrow()
    } else {
      expect(packWindows).toThrow('@vscode/windows-process-tree')
      expect(packWindows).toThrow('Windows packaging requires a Windows host')
      // A workspace link exists everywhere; only its compiled binary proves the addon will load.
      expect(packWindows).toThrow('@orca/windows-security')
    }
  })
})
