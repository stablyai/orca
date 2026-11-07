import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree } from '../../../../src/shared/windows-transient-lock-removal.ts'
import {
  IROH_BUILD_IDENTITY,
  IROH_PREBUILD_FILES
} from '../../orcad-distribution/prebuilds/iroh-prebuild.mjs'
import { mergeManifest } from '../../orcad-distribution/prebuilds/orcad-prebuild-slot-contents.mjs'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../../../electron-builder.config.cjs')
const {
  prunePackagedNodePty,
  prunePackagedParcelWatcher,
  verifyPackagedMainRuntimeDeps
} = require('../../../packaged-runtime-node-modules.cjs')

describe('packaged runtime resources', () => {
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
      await removeTree(resourcesDir)
    }
  })

  it('verifies literal dynamic imports from the packaged main bundle', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-dynamic-imports-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')

      // Cover shipped oxc memoized-import spelling and spaced equivalent.
      const sources = new Map([
        [
          'out/main/index.js',
          'let p=null;function q(){return p??=import(`@anthropic-ai/claude-agent-sdk`),p}'
        ],
        [
          'out/main/agent-hooks/managed-agent-hook-controls.js',
          'import (`@anthropic-ai/claude-agent-sdk`)'
        ]
      ])
      const asar = {
        listPackage: () => [...sources.keys()].map((entry) => `/${entry}`),
        extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).toThrow(
        /@anthropic-ai\/claude-agent-sdk/
      )

      await mkdir(join(resourcesDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), {
        recursive: true
      })
      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('still fails when a required packaged main entry is missing entirely', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-missing-entry-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')

      const asar = {
        listPackage: () => ['/out/main/index.js'],
        extractFile: () => Buffer.from('', 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).toThrow(
        /managed-agent-hook-controls\.js was not found/
      )
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('verifies bare imports that rolldown hoisted into a shared main chunk', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-chunk-imports-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')

      // The entry points themselves carry no specifier; only the shared chunk does.
      const sources = new Map([
        ['out/main/index.js', ''],
        ['out/main/agent-hooks/managed-agent-hook-controls.js', ''],
        ['out/main/chunks/managed-agent-hook-controls-CWf8D-KR.js', 'require(`jsonc-parser`)']
      ])
      // listPackage includes directories that extractFile rejects; mock them to enforce the .js anchor.
      const directories = ['/out', '/out/main', '/out/main/chunks']
      const asar = {
        listPackage: () => [...directories, ...[...sources.keys()].map((entry) => `/${entry}`)],
        extractFile: (_asarPath, internalPath) => {
          const source = sources.get(internalPath)
          if (source === undefined) {
            throw new Error(`Expected to find file at: ${internalPath} but found a directory`)
          }
          return Buffer.from(source, 'utf8')
        }
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).toThrow(/jsonc-parser/)

      await mkdir(join(resourcesDir, 'node_modules', 'jsonc-parser'), { recursive: true })
      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('reads a spread require, whose leading dots are not member access', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-spread-require-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')

      const sources = new Map([
        ['out/main/index.js', 'const all=[...require("jsonc-parser")]'],
        ['out/main/agent-hooks/managed-agent-hook-controls.js', '']
      ])
      const asar = {
        listPackage: () => [...sources.keys()].map((entry) => `/${entry}`),
        extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).toThrow(/jsonc-parser/)
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('ignores member calls onto Orca methods that are themselves named require', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-member-require-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')

      // Registry require(key) members are not packaged bare-module imports, even with literal keys.
      const sources = new Map([
        ['out/main/index.js', 'registry.require("public-a");grants.require(`host-key`)'],
        ['out/main/agent-hooks/managed-agent-hook-controls.js', 'state.import("android-sdk")']
      ])
      const asar = {
        listPackage: () => [...sources.keys()].map((entry) => `/${entry}`),
        extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('prunes non-target node-pty architecture outputs from packaged runtime resources', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-node-pty-prune-'))
    try {
      const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
      const prebuildsDir = join(nodePtyDir, 'prebuilds')
      const binDir = join(nodePtyDir, 'bin')
      await mkdir(join(prebuildsDir, 'darwin-arm64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'darwin-x64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'linux-x64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'win32-x64'), { recursive: true })
      await mkdir(join(binDir, 'darwin-arm64-148'), { recursive: true })
      await mkdir(join(binDir, 'darwin-x64-148'), { recursive: true })
      await mkdir(join(nodePtyDir, 'third_party', 'conpty'), {
        recursive: true
      })
      await mkdir(join(nodePtyDir, 'deps', 'winpty'), { recursive: true })

      prunePackagedNodePty(resourcesDir, 'darwin', 3)

      await expect(readdir(prebuildsDir)).resolves.toEqual(['darwin-arm64'])
      await expect(readdir(binDir)).resolves.toEqual(['darwin-arm64-148'])
      await expect(readdir(join(nodePtyDir, 'third_party'))).resolves.toEqual([])
      await expect(readdir(join(nodePtyDir, 'deps'))).resolves.toEqual([])
      expect(() => prunePackagedNodePty(resourcesDir, 'darwin', 4)).toThrow(
        'Unsupported packaged runtime architecture: 4'
      )
    } finally {
      await removeTree(resourcesDir)
    }
  })

  it('copies the Windows node-pty ConPTY runtime beside the rebuilt addon', async () => {
    for (const [arch, electronArch] of [
      ['x64', 1],
      ['arm64', 3]
    ]) {
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

        prunePackagedNodePty(resourcesDir, 'win32', electronArch)

        await expect(readFile(join(releaseDir, 'conpty', 'conpty.dll'), 'utf8')).resolves.toBe(
          `dll payload ${arch}`
        )
        await expect(readFile(join(releaseDir, 'conpty', 'OpenConsole.exe'), 'utf8')).resolves.toBe(
          `console payload ${arch}`
        )
      } finally {
        await removeTree(resourcesDir)
      }
    }
  })

  it('prunes non-target @parcel/watcher architecture subpackages', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-parcel-watcher-prune-'))
    try {
      const parcelDir = join(resourcesDir, 'node_modules', '@parcel')
      await mkdir(join(parcelDir, 'watcher'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-arm64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-x64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-x64-glibc'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-arm64-glibc'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-win32-x64'), { recursive: true })

      prunePackagedParcelWatcher(resourcesDir, 'linux', 'arm64')

      await expect(readdir(parcelDir).then((entries) => entries.sort())).resolves.toEqual([
        'watcher',
        'watcher-linux-arm64-glibc'
      ])
      expect(() => prunePackagedParcelWatcher(resourcesDir, 'linux', 'universal')).toThrow(
        'Unsupported packaged runtime architecture: universal'
      )
    } finally {
      await removeTree(resourcesDir)
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

      prunePackagedParcelWatcher(resourcesDir, 'linux', 1)

      await expect(readdir(parcelDir).then((entries) => entries.sort())).resolves.toEqual([
        'transformer-js',
        'watcher',
        'watcher-linux-x64-glibc'
      ])
    } finally {
      await removeTree(resourcesDir)
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
      await removeTree(root)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'prunes foreign natives and stages verified Iroh before Linux presence and glibc gates',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-after-pack-prune-order-'))
      const previousPath = process.env.PATH
      const previousPrebuildsDir = process.env.ORCAD_PREBUILDS_DIR
      try {
        const appOutDir = join(root, 'linux-unpacked')
        const resourcesDir = join(appOutDir, 'resources')
        await cp(join(process.cwd(), 'resources', 'plugins'), join(resourcesDir, 'plugins'), {
          recursive: true
        })
        await seedBundledRipgrep(resourcesDir)
        await seedPackagedServePayload(resourcesDir)

        const unpackedMainDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main')
        await mkdir(unpackedMainDir, { recursive: true })
        await writeFile(join(unpackedMainDir, 'daemon-entry.js'), '', 'utf8')
        await writeFile(
          join(resourcesDir, 'app.asar.unpacked', 'out', 'package.json'),
          `${JSON.stringify({ name: 'orca-compiled-output', type: 'commonjs', private: true })}\n`,
          'utf8'
        )

        const unpackedCliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
        await mkdir(join(unpackedCliDir, 'handlers'), { recursive: true })
        await writeFile(join(unpackedCliDir, 'handlers', 'skills.js'), '', 'utf8')
        await writeFile(join(unpackedCliDir, 'index.js'), '', 'utf8')

        const target =
          process.arch === 'x64'
            ? { electronArch: 3, arch: 'arm64', machine: 0xb7, nonTarget: 'x64' }
            : { electronArch: 1, arch: 'x64', machine: 0x3e, nonTarget: 'arm64' }
        const wrongArchPackage = join(
          resourcesDir,
          'node_modules',
          '@parcel',
          `watcher-linux-${target.nonTarget}-glibc`
        )
        await mkdir(wrongArchPackage, { recursive: true })
        const wrongArchElf = Buffer.alloc(20)
        wrongArchElf.set([0x7f, 0x45, 0x4c, 0x46])
        wrongArchElf[5] = 1
        wrongArchElf.writeUInt16LE(target.machine, 18)
        await writeFile(join(wrongArchPackage, 'watcher.node'), wrongArchElf)
        await seedClipboardPublisher(resourcesDir, target.machine)
        const prebuildsDir = join(root, 'orcad-prebuilds')
        const iroh = await seedPackagedIrohFloor(resourcesDir, prebuildsDir, target)
        process.env.ORCAD_PREBUILDS_DIR = prebuildsDir

        await stubObjdump(root)

        await expect(
          electronBuilderConfig.afterPack({
            appOutDir,
            electronPlatformName: 'linux',
            arch: target.electronArch,
            packager: { appInfo: { version: '9.9.9' } }
          })
        ).resolves.toBeUndefined()
        await expect(stat(wrongArchPackage)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(iroh.destination)).resolves.toEqual(iroh.bytes)
      } finally {
        process.env.PATH = previousPath
        if (previousPrebuildsDir === undefined) {
          delete process.env.ORCAD_PREBUILDS_DIR
        } else {
          process.env.ORCAD_PREBUILDS_DIR = previousPrebuildsDir
        }
        await removeTree(root)
      }
    }
  )
})

/** Seed a target floor artifact and loader without any installed optional native package. */
async function seedPackagedIrohFloor(resourcesDir, prebuildsDir, target) {
  const slot = `linux-${target.arch}-glibc`
  const relative = IROH_PREBUILD_FILES[slot]
  const filename = relative.split('/').at(-1)
  const nativePath = join(prebuildsDir, slot, ...relative.split('/'))
  const bytes = Buffer.alloc(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(target.machine, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.writeUInt16LE(64, 52)
  await mkdir(dirname(nativePath), { recursive: true })
  await writeFile(nativePath, bytes)
  const manifest = mergeManifest(null, {
    version: '1.1.0',
    napi: 8,
    nodeHeaders: '24.21.0',
    slot,
    entry: {
      files: { [relative]: createHash('sha256').update(bytes).digest('hex') },
      iroh: IROH_BUILD_IDENTITY
    }
  })
  await writeFile(join(prebuildsDir, 'manifest.json'), JSON.stringify(manifest))
  const packageName = `@number0/iroh-linux-${target.arch}-gnu`
  const loaderDir = join(resourcesDir, 'node_modules', '@number0', 'iroh')
  await mkdir(loaderDir, { recursive: true })
  await writeFile(join(loaderDir, 'index.js'), 'module.exports = {}\n')
  await writeFile(
    join(loaderDir, 'package.json'),
    JSON.stringify({
      name: '@number0/iroh',
      version: IROH_BUILD_IDENTITY.sdkVersion,
      main: 'iroh-js/index.js',
      optionalDependencies: { [packageName]: IROH_BUILD_IDENTITY.sdkVersion }
    })
  )
  return { destination: join(resourcesDir, 'node_modules', packageName, filename), bytes }
}

// Headers model architecture; objdump is stubbed for these packaging-layout tests.
async function seedClipboardPublisher(resourcesDir, machine) {
  const binDir = join(resourcesDir, 'bin')
  await mkdir(binDir, { recursive: true })
  const elf = Buffer.alloc(64)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  elf.writeUInt16LE(2, 16)
  elf.writeUInt16LE(machine, 18)
  elf.writeUInt32LE(1, 20)
  elf.writeUInt16LE(64, 52)
  await writeFile(join(binDir, 'orca-wayland-clipboard'), elf)
}

async function stubObjdump(root) {
  const directory = join(root, 'bin')
  await mkdir(directory)
  await writeFile(join(directory, 'objdump'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  process.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ''}`
}

async function seedPackagedServePayload(resourcesDir) {
  const { SERVE_SELECTION_ENTRY } = require('./verify-packaged-serve-payload.cjs')
  const entry = join(resourcesDir, 'app.asar.unpacked', 'out', ...SERVE_SELECTION_ENTRY.split('/'))
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, '')
  const webDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'renderer')
  await mkdir(join(webDir, 'assets'), { recursive: true })
  await mkdir(join(resourcesDir, 'app.asar.unpacked', 'out', 'cli'), { recursive: true })
  await writeFile(join(webDir, 'web-index.html'), '<script src="./assets/web.js"></script>')
  await writeFile(join(webDir, 'assets', 'web.js'), '')
  await writeFile(
    join(webDir, '.orca-web-client-files.json'),
    JSON.stringify(['web-index.html', 'assets/web.js'])
  )
}

async function seedBundledRipgrep(resourcesDir) {
  const { BUNDLED_RIPGREP_PLATFORMS } = require('../../../bundled-ripgrep-resources.cjs')
  for (const platform of BUNDLED_RIPGREP_PLATFORMS) {
    const dir = join(resourcesDir, 'ripgrep', platform)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, platform.startsWith('win32-') ? 'rg.exe' : 'rg'), '', 'utf8')
  }
}
