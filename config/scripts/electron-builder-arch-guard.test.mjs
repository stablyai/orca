import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeGuestTreeKillArtifactsFixture } from '../../src/shared/guest-tree-kill-artifacts-test-fixture.ts'
import { guestTreeKillSourceHash } from './build-guest-tree-kill.mjs'
import { writeMobileWebBundleFixtureTree } from './mobile-web-bundle-fixture-tree.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

describe('arch-aware packaging guard', () => {
  // electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3.
  const HOST_ARCH = process.arch === 'arm64' ? 3 : 1
  const OTHER_ARCH = process.arch === 'arm64' ? 1 : 3
  const OTHER_ARCH_NAME = process.arch === 'arm64' ? 'x64' : 'arm64'
  const SHERPA_PLATFORM = process.platform === 'win32' ? 'win' : process.platform
  const otherSherpa = `sherpa-onnx-${SHERPA_PLATFORM}-${OTHER_ARCH_NAME}`

  // beforePack also hash-verifies the mobile web bundle, which the unit-test job never builds.
  // Point it at a real bundle built into a temp dir: these tests are about the native-variant
  // guard, and the bundle guard has its own suite.
  let scratch
  let bundleDir
  let guestHelperDir
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'orca-electron-builder-guard-'))
    bundleDir = join(scratch, 'mobile-web')
    await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
    guestHelperDir = join(scratch, 'guest-tree-kill')
    writeGuestTreeKillArtifactsFixture(guestHelperDir)
    const { readFileSync, writeFileSync } = require('node:fs')
    const manifestPath = join(guestHelperDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.sourceSha256 = guestTreeKillSourceHash()
    writeFileSync(manifestPath, JSON.stringify(manifest))
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  const packHost = (arch) =>
    electronBuilderConfig.beforePack(
      { electronPlatformName: process.platform, arch },
      bundleDir,
      () => undefined,
      undefined,
      guestHelperDir
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
          templateDir,
          guestHelperDir
        )
      ).toThrow(`${templateDir} holds an ORCA_LAYOUT_OWNER=main build`)
    } finally {
      await rm(templateDir, { recursive: true, force: true })
    }
  })

  it('requires the other architecture natives to be installed', () => {
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
    } else if (process.platform !== 'win32') {
      expect(() => packHost(OTHER_ARCH)).not.toThrow()
    }
  })

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
      electronBuilderConfig.beforePack(
        { electronPlatformName: 'win32', arch: 1 },
        bundleDir,
        () => undefined,
        undefined,
        guestHelperDir
      )
    if (process.platform === 'win32') {
      expect(packWindows).not.toThrow()
    } else {
      if (!windowsAddon) {
        expect(packWindows).toThrow('@vscode/windows-process-tree')
      }
      expect(packWindows).toThrow('Windows packaging requires a Windows host')
      // A workspace link exists everywhere; only its compiled binary proves the addon will load.
      expect(packWindows).toThrow('@orca/windows-security')
    }
  })
})
