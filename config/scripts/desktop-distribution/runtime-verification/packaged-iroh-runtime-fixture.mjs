import { createHash } from 'node:crypto'
import { cp, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { vi } from 'vitest'
import {
  IROH_BUILD_IDENTITY,
  IROH_PREBUILD_FILES
} from '../../orcad-distribution/prebuilds/iroh-prebuild.mjs'

export const roots = []
export const desktopTargets = Object.keys(IROH_PREBUILD_FILES)
  .filter((slot) => !slot.endsWith('-musl'))
  .map((slot) => {
    const [platform, arch] = slot.split('-')
    return { slot, platform, arch }
  })

/** Minimal target-native headers; fixtures are inspected, never loaded. */
export function nativeBytes(arch, marker = 'patched prebuild', platform = 'linux') {
  const header = Buffer.alloc(platform === 'win32' ? 256 : 64)
  if (platform === 'darwin') {
    header.writeUInt32LE(0xfeedfacf, 0)
    header.writeUInt32LE(0x0100000c, 4)
    header.writeUInt32LE(6, 12)
  } else if (platform === 'win32') {
    header.write('MZ')
    header.writeUInt32LE(64, 0x3c)
    header.write('PE\0\0', 64)
    header.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68)
    header.writeUInt16LE(112, 84)
    header.writeUInt16LE(0x2000, 86)
    header.writeUInt16LE(0x20b, 88)
  } else {
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
    header.writeUInt16LE(3, 16)
    header.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
    header.writeUInt32LE(1, 20)
    header.writeUInt16LE(64, 52)
  }
  return Buffer.concat([header, Buffer.from(marker)])
}

/** Copy an SDK install separately from its manifest-backed patched native artifact. */
export async function stagingFixture(arch, { installedNative = false, platform = 'linux' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-iroh-staging-'))
  roots.push(root)
  const resourcesDir = join(root, 'resources')
  const sourceModules = join(root, 'source/node_modules')
  const nodeModulesDir = join(resourcesDir, 'node_modules')
  const sourceLoader = join(sourceModules, '@number0/iroh')
  const loaderDir = join(nodeModulesDir, '@number0/iroh')
  const slot = `${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`
  const relative = IROH_PREBUILD_FILES[slot]
  const nativeName = basename(relative)
  const packageName = `@number0/${nativeName.replace(/^iroh\./, 'iroh-').replace(/\.node$/, '')}`
  const sourceNative = join(sourceModules, packageName)
  const nativeDir = join(nodeModulesDir, packageName)
  const metadata = {
    name: '@number0/iroh',
    version: '1.1.0',
    main: 'iroh-js/index.js',
    optionalDependencies: Object.fromEntries(
      Object.values(IROH_PREBUILD_FILES).map((file) => [
        `@number0/${basename(file)
          .replace(/^iroh\./, 'iroh-')
          .replace(/\.node$/, '')}`,
        IROH_BUILD_IDENTITY.sdkVersion
      ])
    )
  }
  await mkdir(sourceLoader, { recursive: true })
  await writeFile(join(sourceLoader, 'package.json'), JSON.stringify(metadata))
  await writeFile(join(sourceLoader, 'index.js'), `module.exports = require('${packageName}');\n`)
  const installedBytes = nativeBytes(arch, 'stock npm native', platform)
  if (installedNative) {
    await mkdir(sourceNative, { recursive: true })
    await writeFile(
      join(sourceNative, 'package.json'),
      JSON.stringify({ name: packageName, version: '1.1.0', main: nativeName })
    )
    await writeFile(join(sourceNative, nativeName), installedBytes)
  }
  await cp(sourceModules, nodeModulesDir, { recursive: true })
  // Hardlinks expose accidental writes through a copied pnpm store file.
  await rm(join(loaderDir, 'package.json'))
  await link(join(sourceLoader, 'package.json'), join(loaderDir, 'package.json'))
  if (installedNative) {
    await rm(join(nativeDir, nativeName))
    await link(join(sourceNative, nativeName), join(nativeDir, nativeName))
  }
  const prebuildsDir = join(root, 'prebuilds')
  const artifact = join(prebuildsDir, slot, relative)
  const bytes = nativeBytes(arch, 'patched prebuild', platform)
  await mkdir(dirname(artifact), { recursive: true })
  await writeFile(artifact, bytes)
  const entry = {
    platform,
    arch,
    libc: platform === 'linux' ? 'glibc' : 'none',
    glibc: platform === 'linux' ? '2.28' : null,
    napi: 8,
    iroh: { ...IROH_BUILD_IDENTITY },
    files: { [relative]: createHash('sha256').update(bytes).digest('hex') }
  }
  const manifest = {
    schemaVersion: 2,
    module: 'node-pty',
    version: '1.0.0',
    napi: 8,
    slots: { [slot]: entry }
  }
  const writeManifest = () =>
    writeFile(join(prebuildsDir, 'manifest.json'), JSON.stringify(manifest))
  await writeManifest()
  const registryFetch = vi.fn(() => {
    throw new Error('Packaging must not fetch npm packages')
  })
  vi.stubGlobal('fetch', registryFetch)
  return {
    root,
    resourcesDir,
    nodeModulesDir,
    sourceLoader,
    loaderDir,
    sourceNative,
    nativeDir,
    packageName,
    nativeName,
    metadata,
    installedBytes,
    prebuildsDir,
    slot,
    relative,
    artifact,
    bytes,
    entry,
    manifest,
    writeManifest,
    registryFetch
  }
}
