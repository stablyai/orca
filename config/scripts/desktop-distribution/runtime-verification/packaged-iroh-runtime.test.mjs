import { createHash } from 'node:crypto'
import { cpSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ensureIrohPrebuild } from '../../orcad-distribution/prebuilds/ensure-iroh-prebuild.mjs'
import {
  desktopTargets,
  nativeBytes,
  roots,
  stagingFixture
} from './packaged-iroh-runtime-fixture.mjs'

const require = createRequire(import.meta.url)
const { stagePackagedIrohNative } = require('../../../packaged-runtime-node-modules.cjs')

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(desktopTargets)(
  'accepts a verified patched $slot cache for foreign-host packaging without fetching build inputs',
  async ({ platform: targetPlatform, arch }) => {
    const f = await stagingFixture(arch, { platform: targetPlatform })
    await ensureIrohPrebuild({
      targetPlatform,
      arch,
      root: join(f.root, 'source'),
      prebuildsDir: f.prebuildsDir,
      platform: targetPlatform === 'darwin' ? 'linux' : 'darwin',
      hostArch: arch
    })
    await stagePackagedIrohNative(f.resourcesDir, targetPlatform, arch, f.prebuildsDir)
    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.bytes)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it.each(['missing', 'stale', 'corrupt'])(
  'refuses %s foreign-host build inputs even when the npm native is installed',
  async (damage) => {
    const f = await stagingFixture('arm64', { installedNative: true })
    if (damage === 'missing') {
      await rm(f.prebuildsDir, { recursive: true })
    } else if (damage === 'stale') {
      f.entry.iroh.sourceRevision = 'stale'
      await f.writeManifest()
    } else {
      await writeFile(f.artifact, nativeBytes('arm64', 'tampered cache'))
    }
    await expect(
      ensureIrohPrebuild({
        targetPlatform: 'linux',
        arch: 'arm64',
        root: join(f.root, 'source'),
        prebuildsDir: f.prebuildsDir,
        platform: 'linux',
        hostArch: 'x64'
      })
    ).rejects.toThrow(/linux-arm64-glibc.*native Linux arm64 runner/)
    expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it('refuses an invalid custom prebuild directory instead of producing into a different cache', async () => {
  const f = await stagingFixture('x64')
  await rm(f.artifact)
  await expect(
    ensureIrohPrebuild({
      targetPlatform: 'linux',
      arch: 'x64',
      root: join(f.root, 'source'),
      prebuildsDir: f.prebuildsDir,
      platform: 'linux',
      hostArch: 'x64'
    })
  ).rejects.toThrow(/ORCAD_PREBUILDS_DIR.*linux-x64-glibc/)
  await expect(readFile(f.artifact)).rejects.toThrow(/ENOENT/)
  expect(f.registryFetch).not.toHaveBeenCalled()
})

it('requires Docker to provision a missing native-host cache before staging can proceed', async () => {
  const f = await stagingFixture('x64', { installedNative: true })
  const root = join(f.root, 'source')
  const prebuildsDir = join(root, 'out', 'orcad-prebuilds')
  await expect(
    ensureIrohPrebuild({
      targetPlatform: 'linux',
      arch: 'x64',
      root,
      prebuildsDir,
      platform: 'linux',
      hostArch: 'x64',
      run: () => ({ error: new Error('Docker is not installed') })
    })
  ).rejects.toThrow(/linux-x64-glibc.*requires working Docker/)
  await expect(
    stagePackagedIrohNative(f.resourcesDir, 'linux', 'x64', prebuildsDir)
  ).rejects.toThrow(/missing.*identity/)
  expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.installedBytes)
  expect(f.registryFetch).not.toHaveBeenCalled()
})

it.each(
  desktopTargets
    .filter(({ platform }) => platform !== 'linux' || process.platform !== 'win32')
    .flatMap((target) => ['missing', 'stale'].map((cache) => ({ ...target, cache })))
)(
  'provisions a $cache $slot cache with the existing native producer and rechecks its output',
  async ({ platform, arch, slot, cache }) => {
    const f = await stagingFixture(arch, { platform, installedNative: true })
    const root = join(f.root, 'source')
    const prebuildsDir = join(root, 'out', 'orcad-prebuilds')
    if (cache === 'stale') {
      cpSync(f.prebuildsDir, prebuildsDir, { recursive: true })
      const stale = structuredClone(f.manifest)
      delete stale.slots[slot].iroh.handshakePatchSha256
      await writeFile(join(prebuildsDir, 'manifest.json'), JSON.stringify(stale))
    }
    const node = join(root, 'pinned-node')
    const ensureNode = vi.fn(async () => node)
    const run = vi.fn((_program, args) => {
      if (args[0] === 'info') {
        return { status: 0, stdout: 'false' }
      }
      cpSync(f.prebuildsDir, prebuildsDir, { recursive: true })
      return { status: 0 }
    })
    await expect(
      ensureIrohPrebuild({
        targetPlatform: platform,
        arch,
        root,
        prebuildsDir,
        platform,
        hostArch: arch,
        run,
        ensureNode
      })
    ).resolves.toBe(join(prebuildsDir, slot, f.relative))
    expect(ensureNode).toHaveBeenCalledWith({
      target: slot,
      cacheDir: join(root, 'out', 'node-runtime-cache')
    })
    if (platform === 'linux') {
      expect(run.mock.calls[1][0]).toBe('docker')
      expect(run.mock.calls[1][1]).toContain(slot)
      expect(run.mock.calls[1][1]).toContainEqual(expect.stringMatching(/manylinux_2_28/))
    } else {
      expect(run).toHaveBeenCalledWith(
        node,
        [
          join(
            root,
            'config',
            'scripts',
            'orcad-distribution',
            'prebuilds',
            'build-orcad-prebuilds.mjs'
          ),
          `--slot=${slot}`
        ],
        { cwd: root, stdio: 'inherit' }
      )
    }
    await stagePackagedIrohNative(f.resourcesDir, platform, arch, prebuildsDir)
    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.bytes)
    expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it.each(desktopTargets.filter(({ platform }) => platform !== 'linux'))(
  'rejects a successful $slot producer that returns old stock bytes without the reviewed patch identity',
  async ({ platform, arch }) => {
    const f = await stagingFixture(arch, { platform, installedNative: true })
    delete f.entry.iroh.handshakePatchSha256
    await writeFile(f.artifact, f.installedBytes)
    f.entry.files[f.relative] = createHash('sha256').update(f.installedBytes).digest('hex')
    await f.writeManifest()
    const root = join(f.root, 'source')
    const prebuildsDir = join(root, 'out', 'orcad-prebuilds')
    const run = vi.fn(() => {
      cpSync(f.prebuildsDir, prebuildsDir, { recursive: true })
      return { status: 0 }
    })
    await expect(
      ensureIrohPrebuild({
        targetPlatform: platform,
        arch,
        root,
        prebuildsDir,
        platform,
        hostArch: arch,
        ensureNode: async () => join(root, 'pinned-node'),
        run
      })
    ).rejects.toThrow(/stale|identity/)
    expect(run).toHaveBeenCalledOnce()
    await expect(
      stagePackagedIrohNative(f.resourcesDir, platform, arch, prebuildsDir)
    ).rejects.toThrow(/stale|identity/)
    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.installedBytes)
    expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it.each(desktopTargets.filter(({ platform }) => platform !== 'linux'))(
  'reports the required native tools when $slot provisioning fails instead of using the npm native',
  async ({ platform, arch }) => {
    const f = await stagingFixture(arch, { platform, installedNative: true })
    const root = join(f.root, 'source')
    await expect(
      ensureIrohPrebuild({
        targetPlatform: platform,
        arch,
        root,
        prebuildsDir: join(root, 'out', 'orcad-prebuilds'),
        platform,
        hostArch: arch,
        ensureNode: async () => join(root, 'pinned-node'),
        run: () => ({ status: 1 })
      })
    ).rejects.toThrow(
      platform === 'darwin' ? /Xcode Command Line Tools/ : /Visual Studio.*Windows SDK/
    )
    await expect(
      stagePackagedIrohNative(f.resourcesDir, platform, arch, join(root, 'out', 'orcad-prebuilds'))
    ).rejects.toThrow(/missing.*identity/)
    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.installedBytes)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it.each(desktopTargets.filter(({ platform }) => platform !== 'linux'))(
  'refuses stale $slot caches on foreign hosts or in custom directories without running a producer',
  async ({ platform, arch, slot }) => {
    const f = await stagingFixture(arch, { platform, installedNative: true })
    f.entry.iroh.handshakePatchSha256 = '0'.repeat(64)
    await f.writeManifest()
    const run = vi.fn()
    for (const host of [
      { platform: platform === 'darwin' ? 'linux' : 'darwin', hostArch: arch },
      { platform, hostArch: arch === 'x64' ? 'arm64' : 'x64' },
      { platform, hostArch: arch }
    ]) {
      await expect(
        ensureIrohPrebuild({
          targetPlatform: platform,
          arch,
          root: join(f.root, 'source'),
          prebuildsDir: f.prebuildsDir,
          ...host,
          run
        })
      ).rejects.toThrow(new RegExp(`${slot}.*build:orcad-prebuilds.*ORCAD_PREBUILDS_DIR`))
    }
    expect(run).not.toHaveBeenCalled()
    expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)
