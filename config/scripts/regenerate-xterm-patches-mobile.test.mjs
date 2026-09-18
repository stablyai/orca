import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mobileXtermPatchProfile } from './regenerate-xterm-patches-mobile.mjs'
import {
  patchHash,
  readLockfilePatchHash,
  readLockfileResolutionHashes,
  regenerateXtermPatches
} from './regenerate-xterm-patches.mjs'
import { selectPatchEntries, sourceHunks, splitPatchEntries } from './xterm-patch-text.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const temporaryDirectories = []
const readProject = (file) => readFile(path.join(ROOT, file), 'utf8')
const manifest = JSON.parse(await readProject('config/patches/xterm-upstream.json'))
const mobilePackage = JSON.parse(await readProject('mobile/package.json'))
const desktopCore = manifest.packages.find((entry) => entry.name === '@xterm/xterm')
const desktopSource = await readProject(desktopCore.sourcePatch)
const profile = mobileXtermPatchProfile(manifest, mobilePackage, desktopSource)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('mobile xterm patch generation', () => {
  it('reuses the pinned core build while selecting only mobile memory fixes', () => {
    expect(profile.manifest.upstream).toEqual(manifest.upstream)
    expect(profile.manifest.toolchain).toEqual(manifest.toolchain)
    expect(profile.manifest.packages).toHaveLength(1)
    expect(profile.manifest.packages[0]).toMatchObject({
      name: '@xterm/xterm',
      version: desktopCore.version,
      build: desktopCore.build,
      generatedPaths: desktopCore.generatedPaths
    })
    expect(splitPatchEntries(profile.source).map((entry) => entry.path)).toEqual([
      'src/browser/ColorContrastCache.ts',
      'src/common/buffer/Buffer.ts',
      'src/common/buffer/BufferLine.ts'
    ])
    expect(profile.source).toBe(
      selectPatchEntries(desktopSource, (file) =>
        ['/ColorContrastCache.ts', '/Buffer.ts', '/BufferLine.ts'].some((suffix) =>
          file.endsWith(suffix)
        )
      )
    )
    expect(profile.manifest.packages[0].sourcePatch).toMatch(/^mobile\/patches\/xterm-src\//)
    expect(profile.manifest.packages[0].patch).toMatch(/^mobile\/patches\//)
    expect(desktopCore.sourcePatch).toMatch(/^config\/patches\//)
  })

  it('refuses a divergent or unpinned mobile version before building', () => {
    for (const version of ['6.1.0-beta.302', `^${desktopCore.version}`, undefined]) {
      const changed = {
        ...mobilePackage,
        dependencies: { ...mobilePackage.dependencies, '@xterm/xterm': version }
      }
      expect(() => mobileXtermPatchProfile(manifest, changed, desktopSource)).toThrow('must pin')
    }
  })

  it('refuses missing or duplicate core entries and contrast stanzas', () => {
    for (const packages of [[], [desktopCore, desktopCore]]) {
      expect(() =>
        mobileXtermPatchProfile({ ...manifest, packages }, mobilePackage, desktopSource)
      ).toThrow('exactly one pinned')
    }
    for (const source of ['', profile.source + profile.source]) {
      expect(() => mobileXtermPatchProfile(manifest, mobilePackage, source)).toThrow(
        'exactly one src/browser/ColorContrastCache.ts'
      )
    }
  })

  it('uses the selected manifest and lockfile without requiring desktop files', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'orca-mobile-xterm-profile-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(path.join(repoRoot, 'mobile'))
    const lockfile = 'lockfileVersion: 9.0\n'
    await writeFile(path.join(repoRoot, 'mobile', 'pnpm-lock.yaml'), lockfile)
    regenerateXtermPatches({
      mode: 'check',
      repoRoot,
      workDir: path.join(repoRoot, 'scratch'),
      manifest: { ...profile.manifest, packages: [] },
      lockfileRelativePath: path.join('mobile', 'pnpm-lock.yaml')
    })
    expect(await readFile(path.join(repoRoot, 'mobile', 'pnpm-lock.yaml'), 'utf8')).toBe(lockfile)
  })

  it('ships only mobile memory fixes and all four rebuilt bundle/map files', async () => {
    const core = profile.manifest.packages[0]
    const source = await readProject(core.sourcePatch)
    const patch = await readProject(core.patch)
    expect(source).toBe(profile.source)
    expect(sourceHunks(patch)).toBe(profile.source)
    expect(
      splitPatchEntries(patch)
        .map((entry) => entry.path)
        .sort()
    ).toEqual([
      'lib/xterm.js',
      'lib/xterm.js.map',
      'lib/xterm.mjs',
      'lib/xterm.mjs.map',
      'src/browser/ColorContrastCache.ts',
      'src/common/buffer/Buffer.ts',
      'src/common/buffer/BufferLine.ts'
    ])
    expect(patch).not.toContain('xterm-composition-transaction-accepted')
    const lockfile = await readProject('mobile/pnpm-lock.yaml')
    const key = `${core.name}@${core.version}`
    const hash = patchHash(patch)
    expect(readLockfilePatchHash(lockfile, key)).toBe(hash)
    expect(readLockfileResolutionHashes(lockfile, key).length).toBeGreaterThan(0)
    expect(new Set(readLockfileResolutionHashes(lockfile, key))).toEqual(new Set([hash]))
  })
})
