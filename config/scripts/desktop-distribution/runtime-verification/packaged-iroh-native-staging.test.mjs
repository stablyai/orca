import { createHash } from 'node:crypto'
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { copyScriptWithLocalModules } from '../../test-fixtures/script-copy-closure/script-module-dependencies.mjs'
import {
  desktopTargets,
  nativeBytes,
  roots,
  stagingFixture
} from './packaged-iroh-runtime-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  assertPackagedIrohNativeVariantInstalled,
  prunePackagedIrohNapi,
  stagePackagedIrohNative
} = require('../../../packaged-runtime-node-modules.cjs')

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([
  ['x64', 'x64'],
  ['x64', 1],
  ['arm64', 'arm64'],
  ['arm64', 3]
])(
  'stages GNU %s from a verified artifact without an installed target package (arch %s)',
  async (arch, electronArch) => {
    const f = await stagingFixture(arch)
    expect(f.manifest.version).not.toBe(f.metadata.version)
    await expect(readdir(f.nativeDir)).rejects.toThrow(/ENOENT/)
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('linux', electronArch, f.nodeModulesDir)
    ).toThrow(f.packageName)

    await stagePackagedIrohNative(f.resourcesDir, 'linux', electronArch, f.prebuildsDir)

    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.bytes)
    expect(JSON.parse(await readFile(join(f.nativeDir, 'package.json'), 'utf8'))).toMatchObject({
      name: f.packageName,
      version: f.metadata.version,
      main: basename(f.relative)
    })
    expect(JSON.parse(await readFile(join(f.loaderDir, 'package.json'), 'utf8'))).toEqual({
      ...f.metadata,
      main: 'index.js'
    })
    expect(await readFile(join(f.loaderDir, 'index.js'))).toEqual(
      await readFile(join(f.sourceLoader, 'index.js'))
    )
    expect(JSON.parse(await readFile(join(f.sourceLoader, 'package.json'), 'utf8'))).toEqual(
      f.metadata
    )
    await expect(readdir(f.sourceNative)).rejects.toThrow(/ENOENT/)
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('linux', electronArch, f.nodeModulesDir)
    ).not.toThrow()
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it.each(desktopTargets)(
  'replaces copied $slot npm native bytes without mutating the source install',
  async ({ platform, arch }) => {
    const f = await stagingFixture(arch, { installedNative: true, platform })
    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.installedBytes)
    expect(f.installedBytes).not.toEqual(f.bytes)
    const localNative = join(f.loaderDir, f.nativeName)
    const sourceLocalNative = join(f.sourceLoader, f.nativeName)
    await writeFile(sourceLocalNative, f.installedBytes)
    await link(sourceLocalNative, localNative)
    await writeFile(join(f.nativeDir, 'stale.node'), f.installedBytes)
    const sourceNested = join(f.sourceLoader, 'node_modules', f.packageName)
    const copiedNested = join(f.loaderDir, 'node_modules', f.packageName)
    await mkdir(sourceNested, { recursive: true })
    await writeFile(
      join(sourceNested, 'package.json'),
      JSON.stringify({ name: f.packageName, main: f.nativeName })
    )
    await link(join(f.sourceNative, f.nativeName), join(sourceNested, f.nativeName))
    await cp(join(f.sourceLoader, 'node_modules'), join(f.loaderDir, 'node_modules'), {
      recursive: true
    })

    await stagePackagedIrohNative(f.resourcesDir, platform, arch, f.prebuildsDir)

    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.bytes)
    expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
    await expect(readFile(localNative)).rejects.toThrow(/ENOENT/)
    expect(await readFile(sourceLocalNative)).toEqual(f.installedBytes)
    await expect(readdir(copiedNested)).rejects.toThrow(/ENOENT/)
    expect(await readFile(join(sourceNested, f.nativeName))).toEqual(f.installedBytes)
    expect(createRequire(join(f.loaderDir, 'index.js')).resolve(f.packageName)).toBe(
      await realpath(join(f.nativeDir, f.nativeName))
    )
    expect((await readdir(f.nativeDir)).sort()).toEqual([f.nativeName, 'package.json'].sort())
    expect(JSON.parse(await readFile(join(f.loaderDir, 'package.json'), 'utf8')).main).toBe(
      'index.js'
    )
    expect(JSON.parse(await readFile(join(f.sourceLoader, 'package.json'), 'utf8'))).toEqual(
      f.metadata
    )
    expect(() =>
      assertPackagedIrohNativeVariantInstalled(platform, arch, f.nodeModulesDir)
    ).not.toThrow()
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

for (const arch of ['x64', 'arm64']) {
  it.each([
    [
      'prebuild directory',
      (f) => rm(f.prebuildsDir, { recursive: true }),
      /missing|manifest|not built/i
    ],
    ['manifest', (f) => rm(join(f.prebuildsDir, 'manifest.json')), /missing|manifest|not built/i],
    [
      'target slot',
      async (f) => {
        delete f.manifest.slots[f.slot]
        await f.writeManifest()
      },
      /missing|manifest|not built/i
    ],
    ['native file', (f) => rm(f.artifact), /missing|ENOENT|not.*exist/i],
    [
      'identity',
      async (f) => {
        delete f.entry.iroh
        await f.writeManifest()
      },
      /identity|stale/i
    ],
    [
      'stale identity',
      async (f) => {
        f.entry.iroh.sourceRevision = 'stale'
        await f.writeManifest()
      },
      /identity|stale/i
    ],
    [
      'stock identity without reviewed patch',
      async (f) => {
        delete f.entry.iroh.handshakePatchSha256
        await f.writeManifest()
      },
      /identity|stale/i
    ],
    [
      'stale reviewed patch',
      async (f) => {
        f.entry.iroh.handshakePatchSha256 = '0'.repeat(64)
        await f.writeManifest()
      },
      /identity|stale/i
    ],
    [
      'SDK version',
      (f) =>
        writeFile(
          join(f.loaderDir, 'package.json'),
          JSON.stringify({
            ...f.metadata,
            version: '1.2.0',
            optionalDependencies: { [f.packageName]: '1.2.0' }
          })
        ),
      /version|stale/i
    ],
    [
      'target dependency declaration',
      (f) =>
        writeFile(
          join(f.loaderDir, 'package.json'),
          JSON.stringify({ ...f.metadata, optionalDependencies: {} })
        ),
      /dependency|declar|publish|version/i
    ],
    [
      'target dependency version',
      (f) =>
        writeFile(
          join(f.loaderDir, 'package.json'),
          JSON.stringify({ ...f.metadata, optionalDependencies: { [f.packageName]: '1.2.0' } })
        ),
      /version|match|dependency|declar/i
    ],
    [
      'native hash',
      async (f) => {
        f.entry.files[f.relative] = '0'.repeat(64)
        await f.writeManifest()
      },
      /hash|sha256/i
    ],
    [
      'native hash entry',
      async (f) => {
        delete f.entry.files[f.relative]
        await f.writeManifest()
      },
      /hash|sha256|missing/i
    ],
    [
      'native architecture',
      async (f) => {
        const bytes = nativeBytes(arch === 'x64' ? 'arm64' : 'x64')
        await writeFile(f.artifact, bytes)
        f.entry.files[f.relative] = createHash('sha256').update(bytes).digest('hex')
        await f.writeManifest()
      },
      /architecture|machine|ELF/i
    ]
  ])(
    `rejects invalid ${arch} %s rather than retaining copied npm native bytes`,
    async (_name, damage, error) => {
      const f = await stagingFixture(arch, { installedNative: true })
      await damage(f)
      await expect(
        stagePackagedIrohNative(f.resourcesDir, 'linux', arch, f.prebuildsDir)
      ).rejects.toThrow(error)
      expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.installedBytes)
      expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
      expect(f.registryFetch).not.toHaveBeenCalled()
    }
  )
}

it.each([
  ['darwin', 'x64'],
  ['linux', 'arm'],
  ['linux', 'ia32'],
  ['linux', 2]
])(
  'leaves unsupported %s/%s resources unchanged without requiring SDK or prebuild paths',
  async (platform, arch) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-iroh-unsupported-'))
    roots.push(root)
    const resourcesDir = join(root, 'resources')
    await mkdir(resourcesDir)
    await writeFile(join(resourcesDir, 'untouched.node'), 'original native bytes')
    await stagePackagedIrohNative(resourcesDir, platform, arch, join(root, 'missing-prebuilds'))
    expect(await readdir(resourcesDir)).toEqual(['untouched.node'])
    expect(await readFile(join(resourcesDir, 'untouched.node'), 'utf8')).toBe(
      'original native bytes'
    )
  }
)

it.each(desktopTargets.filter(({ platform }) => platform !== 'linux'))(
  'defers the missing $slot npm native to patched-prebuild staging in the desktop input guard',
  async ({ platform, arch }) => {
    const f = await stagingFixture(arch, { platform })
    const root = join(f.root, 'source')
    await writeFile(join(root, 'package.json'), '{}')
    copyScriptWithLocalModules(
      require.resolve('../../../packaged-runtime-node-modules.cjs'),
      join(root, 'config')
    )
    if (platform === 'win32') {
      const processTreeDir = join(root, 'node_modules', '@vscode', 'windows-process-tree')
      await mkdir(processTreeDir, { recursive: true })
      await writeFile(join(processTreeDir, 'package.json'), '{}')
      for (const name of ['registry', 'security']) {
        const releaseDir = join(
          root,
          'node_modules',
          '@orca',
          `windows-${name}`,
          'build',
          'Release'
        )
        await mkdir(releaseDir, { recursive: true })
        await writeFile(
          join(releaseDir, `orca_windows_${name}.node`),
          nativeBytes(arch, '', 'win32')
        )
      }
    }
    const { assertPackagedNativeVariantsInstalled } = createRequire(join(root, 'package.json'))(
      './config/packaged-runtime-node-modules.cjs'
    )
    expect(() => assertPackagedNativeVariantsInstalled(platform, arch)).not.toThrow()
    await expect(readdir(f.sourceNative)).rejects.toThrow(/ENOENT/)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it('collects installed Iroh optional dependency closures without requiring a host SDK variant', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-iroh-closure-')))
  try {
    copyScriptWithLocalModules(
      require.resolve('../../../packaged-runtime-node-modules.cjs'),
      join(root, 'config')
    )
    const writePackage = async (directory, metadata) => {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify(metadata))
    }
    for (const name of [
      '@anthropic-ai/claude-agent-sdk',
      '@linear/sdk',
      '@orca/process-host',
      '@parcel/watcher',
      'electron-updater',
      'i18next',
      'jsonc-parser',
      'node-pty',
      'posthog-node',
      'proper-lockfile',
      'qrcode',
      'smol-toml',
      'ssh2',
      'tweetnacl',
      'ws',
      'yaml',
      'zod'
    ]) {
      await writePackage(join(root, 'node_modules', name), { name })
    }
    const loaderDir = join(root, 'node_modules', '@number0', 'iroh')
    const nativeDir = join(loaderDir, 'node_modules', '@number0', 'iroh-linux-x64-gnu')
    await writePackage(loaderDir, {
      name: '@number0/iroh',
      optionalDependencies: { '@number0/iroh-linux-x64-gnu': '1.1.0' }
    })
    await writePackage(nativeDir, {
      name: '@number0/iroh-linux-x64-gnu',
      dependencies: { 'native-session-state': '1.0.0' }
    })
    await writePackage(join(nativeDir, 'node_modules', 'native-session-state'), {
      name: 'native-session-state'
    })
    const { createPackagedRuntimeNodeModuleResources } = createRequire(join(root, 'package.json'))(
      './config/packaged-runtime-node-modules.cjs'
    )
    const resources = createPackagedRuntimeNodeModuleResources('linux')
    expect(
      resources
        .map((resource) => resource.to)
        .filter((target) => target.startsWith(join('node_modules', '@number0', 'iroh')))
    ).toEqual([
      join('node_modules', '@number0', 'iroh'),
      join('node_modules', '@number0', 'iroh-linux-x64-gnu')
    ])
    expect(
      resources.find((resource) => resource.to === join('node_modules', 'native-session-state'))
    ).toMatchObject({ from: join(nativeDir, 'node_modules', 'native-session-state') })

    await rm(nativeDir, { recursive: true })
    const withoutNative = createPackagedRuntimeNodeModuleResources('linux').map(
      (resource) => resource.to
    )
    expect(withoutNative).toContain(join('node_modules', '@number0', 'iroh'))
    expect(withoutNative).not.toContain(join('node_modules', '@number0', 'iroh-linux-x64-gnu'))
    expect(withoutNative).not.toContain(join('node_modules', 'native-session-state'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('prunes non-target @number0/iroh platform subpackages from packaged runtime resources', async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-iroh-napi-prune-'))
  try {
    const scopeDir = join(resourcesDir, 'node_modules', '@number0')
    await mkdir(join(scopeDir, 'iroh'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-darwin-arm64'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-linux-x64-gnu'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-linux-arm64-musl'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-win32-x64-msvc'), { recursive: true })

    prunePackagedIrohNapi(resourcesDir, 'darwin', 'arm64')

    await expect(readdir(scopeDir).then((entries) => entries.sort())).resolves.toEqual([
      'iroh',
      'iroh-darwin-arm64'
    ])
  } finally {
    await rm(resourcesDir, { recursive: true, force: true })
  }
})

it('requires the GNU Iroh binary and reports unsupported Darwin x64 without blocking packaging', async () => {
  const nodeModulesDir = await mkdtemp(join(tmpdir(), 'orca-iroh-native-'))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const loaderDir = join(nodeModulesDir, '@number0', 'iroh')
    const nativeDir = join(nodeModulesDir, '@number0', 'iroh-linux-x64-gnu')
    await mkdir(loaderDir, { recursive: true })
    await writeFile(
      join(loaderDir, 'package.json'),
      JSON.stringify({
        version: '1.1.0',
        optionalDependencies: {
          '@number0/iroh-linux-x64-gnu': '1.1.0',
          '@number0/iroh-linux-x64-musl': '1.1.0'
        }
      })
    )
    expect(() => assertPackagedIrohNativeVariantInstalled('linux', 'x64', nodeModulesDir)).toThrow(
      '@number0/iroh-linux-x64-gnu'
    )
    await mkdir(nativeDir, { recursive: true })
    await writeFile(
      join(nativeDir, 'package.json'),
      JSON.stringify({ main: 'iroh.linux-x64-gnu.node' })
    )
    expect(() => assertPackagedIrohNativeVariantInstalled('linux', 'x64', nodeModulesDir)).toThrow(
      'native .node binary'
    )
    await writeFile(join(nativeDir, 'iroh.linux-x64-gnu.node'), '')
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('linux', 'x64', nodeModulesDir)
    ).not.toThrow()
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('darwin', 'x64', nodeModulesDir)
    ).not.toThrow()
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Iroh is unavailable on darwin/x64')
    )
  } finally {
    warning.mockRestore()
    await rm(nodeModulesDir, { recursive: true, force: true })
  }
})
