import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeMobileWebBundleFixtureTree } from '../../build/mobile-web-app/mobile-web-bundle-fixture-tree.mjs'

const REPO_ROOT = join(import.meta.dirname, '../../..', '..')

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../../../electron-builder.config.cjs')
const { copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('electron-builder config', () => {
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

  // CI never creates ~270MB/branch out/electron-dev caches; only local packages exposed this bloat.

  // Duplicated relay.js added 14MB to asar and AV quarantine gutted the entire archive (#20966); packaged app uses resources/relay.

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

  // CLI Node mode cannot read asar; packed entry sends orca serve to Electron (#27307).

  // Swept one-time /tmp asar extracts cause web-client 500s and phone bundle failures until restart (#27976).

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
})

describe('arch-aware packaging guard', () => {
  // electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3.
  const HOST_ARCH = process.arch === 'arm64' ? 3 : 1

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

  // The host's own build is the foreign-arch case: a Windows checkout compiles these for its CPU only.
})
