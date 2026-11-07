import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { COMPAT_SERVER_TARGETS, SERVER_TARGETS } from '../../../../src/shared/node-runtime-pin.ts'
import {
  ORCAD_IROH_DIR,
  ORCAD_IROH_LINUX_X64_GLIBC_ARTIFACTS,
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadArtifactFilenames
} from '../../../../src/shared/orcad-artifacts.ts'
import { readOrcadArtifactIdentity } from '../../../../src/main/orcad/orcad-artifact-identity.ts'
import { IROH_BUILD_IDENTITY, IROH_PREBUILD_FILES } from '../prebuilds/iroh-prebuild.mjs'
import { computeOrcadFullVersion } from './orcad-artifact-version.mjs'
import { stageOrcadIroh } from './orcad-iroh-package.mjs'

const roots = []
afterEach(() => {
  vi.unstubAllGlobals()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

/** Minimal ELF64 shared-object header; fixtures are inspected, never loaded. */
function nativeBytes(arch = 'x64', marker = 'floor prebuild') {
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  header.writeUInt16LE(3, 16)
  header.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  header.writeUInt32LE(1, 20)
  header.writeUInt16LE(64, 52)
  return Buffer.concat([header, Buffer.from(marker)])
}

/** Keep node-pty's manifest version distinct from the pinned SDK identity. */
function fixture({ installedNative = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orcad-iroh-'))
  roots.push(root)
  const source = join(root, ORCAD_IROH_DIR)
  const native = join(source, 'node_modules/@number0/iroh-linux-x64-gnu')
  mkdirSync(source, { recursive: true })
  const metadata = {
    name: '@number0/iroh',
    version: '1.1.0',
    type: 'commonjs',
    main: 'iroh-js/index.js',
    license: 'MIT OR Apache-2.0',
    optionalDependencies: { '@number0/iroh-linux-x64-gnu': '1.1.0' }
  }
  writeFileSync(join(source, 'package.json'), JSON.stringify(metadata))
  writeFileSync(
    join(source, 'index.js'),
    "const binding = require('./iroh.linux-x64-gnu.node');\n" +
      'module.exports = binding;\nmodule.exports.Endpoint = binding.Endpoint;\n'
  )
  if (installedNative) {
    mkdirSync(join(native, 'native'), { recursive: true })
    writeFileSync(join(native, 'package.json'), JSON.stringify({ main: 'native/declared.node' }))
    writeFileSync(join(native, 'native/declared.node'), nativeBytes('x64', 'too-new npm native'))
  }
  const prebuildsDir = join(root, 'prebuilds')
  const relative = IROH_PREBUILD_FILES['linux-x64-glibc']
  const artifact = join(prebuildsDir, 'linux-x64-glibc', relative)
  const bytes = nativeBytes()
  mkdirSync(dirname(artifact), { recursive: true })
  writeFileSync(artifact, bytes)
  const entry = {
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
    glibc: '2.28',
    napi: 8,
    iroh: { ...IROH_BUILD_IDENTITY },
    files: { [relative]: createHash('sha256').update(bytes).digest('hex') }
  }
  const manifest = {
    schemaVersion: 2,
    module: 'node-pty',
    version: '1.0.0',
    napi: 8,
    slots: { 'linux-x64-glibc': entry }
  }
  const writeManifest = () =>
    writeFileSync(join(prebuildsDir, 'manifest.json'), JSON.stringify(manifest))
  writeManifest()
  const registryFetch = vi.fn(() => {
    throw new Error('Staging must not fetch npm packages')
  })
  vi.stubGlobal('fetch', registryFetch)
  return {
    root,
    source,
    native,
    output: join(root, 'output'),
    metadata,
    prebuildsDir,
    relative,
    artifact,
    bytes,
    entry,
    manifest,
    writeManifest,
    registryFetch
  }
}

it('ignores installed npm native bytes and stages the unchanged loader with normalized metadata', async () => {
  const { root, source, native, output, metadata, prebuildsDir, bytes, registryFetch } = fixture()
  const installedBefore = readFileSync(join(native, 'native/declared.node'))
  expect(installedBefore).not.toEqual(bytes)
  await stageOrcadIroh(root, output, 'linux-x64-glibc', prebuildsDir)
  const staged = join(output, ORCAD_IROH_DIR)
  expect(readFileSync(join(staged, 'index.js'))).toEqual(readFileSync(join(source, 'index.js')))
  expect(readFileSync(join(staged, 'iroh.linux-x64-gnu.node'))).toEqual(bytes)
  expect(JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))).toEqual({
    ...metadata,
    main: 'index.js'
  })
  expect(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))).toEqual(metadata)
  expect(readFileSync(join(native, 'native/declared.node'))).toEqual(installedBefore)
  expect(existsSync(join(output, 'node_modules/@number0/iroh-linux-x64-gnu'))).toBe(false)
  expect(registryFetch).not.toHaveBeenCalled()
})

it('stages the verified target artifact on a cross-host install without any native package', async () => {
  const { root, source, output, prebuildsDir, bytes, manifest, metadata, registryFetch } = fixture({
    installedNative: false
  })
  expect(manifest.version).not.toBe(metadata.version)
  await stageOrcadIroh(root, output, 'linux-x64-glibc', prebuildsDir)
  expect(readFileSync(join(output, ORCAD_IROH_DIR, 'iroh.linux-x64-gnu.node'))).toEqual(bytes)
  expect(existsSync(join(source, 'node_modules'))).toBe(false)
  expect(existsSync(join(root, 'out/.orcad-native-packages'))).toBe(false)
  expect(registryFetch).not.toHaveBeenCalled()
})

it('requires an explicit prebuild directory even with an installed npm native', async () => {
  const { root, output, registryFetch } = fixture()
  await expect(stageOrcadIroh(root, output, 'linux-x64-glibc', undefined)).rejects.toThrow(
    /prebuild directory is required/i
  )
  expect(existsSync(output)).toBe(false)
  expect(registryFetch).not.toHaveBeenCalled()
})

it.each([
  [
    'prebuild directory',
    (f) => rmSync(f.prebuildsDir, { recursive: true }),
    /missing|manifest|not built/i
  ],
  ['manifest', (f) => rmSync(join(f.prebuildsDir, 'manifest.json')), /missing|manifest|not built/i],
  [
    'slot entry',
    (f) => {
      delete f.manifest.slots['linux-x64-glibc']
      f.writeManifest()
    },
    /missing|manifest|not built/i
  ],
  ['native file', (f) => rmSync(f.artifact), /missing|ENOENT|not.*exist/i],
  [
    'identity',
    (f) => {
      delete f.entry.iroh
      f.writeManifest()
    },
    /identity|stale/i
  ],
  [
    'stale identity',
    (f) => {
      f.entry.iroh.sourceRevision = 'stale'
      f.writeManifest()
    },
    /identity|stale/i
  ],
  [
    'SDK version',
    (f) => {
      writeFileSync(
        join(f.source, 'package.json'),
        JSON.stringify({ ...f.metadata, version: '1.2.0' })
      )
    },
    /version|stale/i
  ],
  [
    'native hash',
    (f) => {
      f.entry.files[f.relative] = '0'.repeat(64)
      f.writeManifest()
    },
    /hash|sha256/i
  ],
  [
    'native hash entry',
    (f) => {
      delete f.entry.files[f.relative]
      f.writeManifest()
    },
    /hash|sha256|missing/i
  ],
  [
    'native architecture',
    (f) => {
      const bytes = nativeBytes('arm64')
      writeFileSync(f.artifact, bytes)
      f.entry.files[f.relative] = createHash('sha256').update(bytes).digest('hex')
      f.writeManifest()
    },
    /architecture|machine|ELF/i
  ]
])(
  'fails closed for invalid %s despite installed npm native bytes',
  async (_name, damage, error) => {
    const f = fixture()
    damage(f)
    await expect(
      stageOrcadIroh(f.root, f.output, 'linux-x64-glibc', f.prebuildsDir)
    ).rejects.toThrow(error)
    expect(existsSync(f.output)).toBe(false)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it.each(['package.json', 'index.js'])(
  'fails clearly when the SDK loader is missing %s',
  async (missing) => {
    const { root, source, output, prebuildsDir, registryFetch } = fixture()
    rmSync(join(source, missing))
    await expect(stageOrcadIroh(root, output, 'linux-x64-glibc', prebuildsDir)).rejects.toThrow(
      /Cannot stage Orcad linux-x64-glibc Iroh/
    )
    expect(registryFetch).not.toHaveBeenCalled()
  }
)

it.each(
  [...SERVER_TARGETS, ...COMPAT_SERVER_TARGETS].filter((target) => target !== 'linux-x64-glibc')
)('leaves %s builds independent of installed Iroh packages', async (target) => {
  const root = mkdtempSync(join(tmpdir(), 'orcad-no-iroh-'))
  roots.push(root)
  const output = join(root, 'output')
  await stageOrcadIroh(root, output, target, undefined)
  expect(existsSync(output)).toBe(false)
})

it.each(ORCAD_IROH_LINUX_X64_GLIBC_ARTIFACTS)(
  'hashes the Iroh closure and rejects missing %s',
  async (filename) => {
    const target = 'linux-x64-glibc'
    const root = mkdtempSync(join(tmpdir(), 'orcad-iroh-version-'))
    roots.push(root)
    const pageAsset = 'out/mobile-web/index.html'
    for (const artifact of orcadArtifactFilenames(target, [pageAsset])) {
      const path = join(root, artifact)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        artifact === ORCAD_MOBILE_WEB_MANIFEST
          ? JSON.stringify({ assets: [{ path: 'index.html' }] })
          : artifact
      )
    }
    writeFileSync(join(root, ORCAD_SERVER_TARGET_FILENAME), `${target}\n`)
    const before = computeOrcadFullVersion(root, { target })
    writeFileSync(join(root, filename), 'updated Iroh artifact')
    const after = computeOrcadFullVersion(root, { target })
    expect(after).not.toBe(before)
    expect(await readOrcadArtifactIdentity(root)).toBe(after)
    rmSync(join(root, filename))
    expect(() => computeOrcadFullVersion(root, { target })).toThrow(filename)
    await expect(readOrcadArtifactIdentity(root)).rejects.toThrow(filename)
  }
)
