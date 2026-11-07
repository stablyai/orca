import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as provisioner from './ensure-iroh-prebuild.mjs'
import { IROH_BUILD_IDENTITY, IROH_PREBUILD_FILES } from './iroh-prebuild.mjs'
import { ensureSourceIrohRuntime } from './stage-source-iroh.mjs'

const roots = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Target headers are inspected, never loaded as native modules. */
function nativeBytes(slot, marker = 'patched') {
  const [platform, arch] = slot.split('-')
  const bytes = Buffer.alloc(platform === 'win32' ? 256 : 64)
  if (platform === 'linux') {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
    bytes.writeUInt16LE(3, 16)
    bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  } else if (platform === 'darwin') {
    bytes.writeUInt32LE(0xfeedfacf)
    bytes.writeUInt32LE(0x0100000c, 4)
    bytes.writeUInt32LE(6, 12)
  } else {
    bytes.write('MZ')
    bytes.writeUInt32LE(64, 0x3c)
    bytes.write('PE\0\0', 64)
    bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68)
    bytes.writeUInt16LE(112, 84)
    bytes.writeUInt16LE(0x2000, 86)
    bytes.writeUInt16LE(0x20b, 88)
  }
  return Buffer.concat([bytes, Buffer.from(marker)])
}

/** Separate the stock npm package from manifest-qualified producer bytes. */
function fixture(slot = 'linux-x64-glibc') {
  const root = mkdtempSync(join(tmpdir(), 'orca-source-iroh-'))
  roots.push(root)
  const [platform, arch, libc] = slot.split('-')
  const input = { root, platform, arch, libc, provision: false }
  const stockDir = join(root, 'node_modules', '@number0', 'iroh')
  mkdirSync(stockDir, { recursive: true })
  writeFileSync(
    join(stockDir, 'package.json'),
    JSON.stringify({
      name: '@number0/iroh',
      version: IROH_BUILD_IDENTITY.sdkVersion,
      main: 'stock.js',
      optionalDependencies: Object.fromEntries(
        Object.values(IROH_PREBUILD_FILES).map((file) => [
          `@number0/${basename(file)
            .replace(/^iroh\./, 'iroh-')
            .replace(/\.node$/, '')}`,
          IROH_BUILD_IDENTITY.sdkVersion
        ])
      )
    })
  )
  writeFileSync(join(stockDir, 'stock.js'), 'throw new Error("stock SDK must not load")\n')
  const prebuildsDir = join(root, 'out', 'orcad-prebuilds')
  input.prebuildsDir = prebuildsDir
  const relative = IROH_PREBUILD_FILES[slot]
  const source = join(prebuildsDir, slot, relative)
  const entry = { iroh: structuredClone(IROH_BUILD_IDENTITY), files: {} }
  const writeManifest = () =>
    writeFileSync(
      join(prebuildsDir, 'manifest.json'),
      JSON.stringify({
        slots: { [slot]: entry }
      })
    )
  const publish = (marker = 'patched') => {
    const bytes = nativeBytes(slot, marker)
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, bytes)
    entry.files[relative] = createHash('sha256').update(bytes).digest('hex')
    writeManifest()
    return bytes
  }
  const bytes = publish()
  const packageDir = join(root, 'out', 'node_modules', '@number0', 'iroh')
  return { root, input, slot, source, entry, bytes, packageDir, stockDir, publish, writeManifest }
}

function identity(path) {
  const { ino, mtimeMs, size } = lstatSync(path)
  return { ino, mtimeMs, size }
}

describe('source patched Iroh staging', () => {
  it.each(Object.keys(IROH_PREBUILD_FILES))(
    'stages qualified %s where emitted modules resolve it',
    async (slot) => {
      const f = fixture(slot)
      const stockJson = readFileSync(join(f.stockDir, 'package.json'))
      const produce = vi.spyOn(provisioner, 'ensureIrohPrebuild')
      const result = await ensureSourceIrohRuntime(f.input)
      const metadata = JSON.parse(readFileSync(join(f.packageDir, 'package.json'), 'utf8'))
      expect(metadata).toEqual({
        name: '@number0/iroh',
        version: IROH_BUILD_IDENTITY.sdkVersion,
        main: `./native-${f.entry.files[IROH_PREBUILD_FILES[slot]]}.node`
      })
      expect(readFileSync(result.nativePath)).toEqual(f.bytes)
      for (const emitted of ['main/index.cjs', 'cli/index.cjs']) {
        expect(createRequire(join(f.root, 'out', emitted)).resolve('@number0/iroh')).toBe(
          result.nativePath
        )
      }
      expect(readFileSync(join(f.stockDir, 'package.json'))).toEqual(stockJson)
      expect(readdirSync(f.stockDir).sort()).toEqual(['package.json', 'stock.js'])
      expect(readdirSync(f.packageDir).sort()).toEqual(
        [basename(result.nativePath), 'package.json'].sort()
      )
      expect(produce).not.toHaveBeenCalled()
    }
  )

  it('reuses immutable hash-named bytes and unchanged package metadata without writes', async () => {
    const f = fixture()
    const first = await ensureSourceIrohRuntime(f.input)
    const json = join(f.packageDir, 'package.json')
    const before = [identity(first.nativePath), identity(json)]
    expect(await ensureSourceIrohRuntime(f.input)).toEqual(first)
    expect([identity(first.nativePath), identity(json)]).toEqual(before)
  })

  it('publishes a new qualified hash without overwriting or deleting the previous addon', async () => {
    const f = fixture()
    const first = await ensureSourceIrohRuntime(f.input)
    const before = identity(first.nativePath)
    const nextBytes = f.publish('new qualified artifact')
    const next = await ensureSourceIrohRuntime(f.input)
    expect(next.nativePath).not.toBe(first.nativePath)
    expect(readFileSync(next.nativePath)).toEqual(nextBytes)
    expect(readFileSync(first.nativePath)).toEqual(f.bytes)
    expect(identity(first.nativePath)).toEqual(before)
  })

  it('replaces hardlinked package metadata atomically, leaving the original inode untouched', async () => {
    const f = fixture()
    mkdirSync(f.packageDir, { recursive: true })
    const stockJson = join(f.stockDir, 'package.json')
    const original = readFileSync(stockJson)
    linkSync(stockJson, join(f.packageDir, 'package.json'))
    await ensureSourceIrohRuntime(f.input)
    expect(readFileSync(stockJson)).toEqual(original)
    expect(lstatSync(stockJson).ino).not.toBe(lstatSync(join(f.packageDir, 'package.json')).ino)
  })

  it('refuses a corrupt hash-named addon instead of overwriting a possibly loaded file', async () => {
    const f = fixture()
    const result = await ensureSourceIrohRuntime(f.input)
    writeFileSync(result.nativePath, 'corrupt loaded inode')
    const before = identity(result.nativePath)
    await expect(ensureSourceIrohRuntime(f.input)).rejects.toThrow(
      /hash mismatch.*refusing to overwrite/
    )
    expect(readFileSync(result.nativePath, 'utf8')).toBe('corrupt loaded inode')
    expect(identity(result.nativePath)).toEqual(before)
  })

  it.each(['identity', 'hash', 'architecture', 'SDK version'])(
    'rejects invalid %s before publishing',
    async (damage) => {
      const f = fixture()
      if (damage === 'identity') {
        f.entry.iroh.handshakePatchSha256 = '0'.repeat(64)
        f.writeManifest()
      } else if (damage === 'hash') {
        writeFileSync(f.source, 'corrupt producer output')
      } else if (damage === 'architecture') {
        const bytes = nativeBytes('linux-arm64-glibc')
        writeFileSync(f.source, bytes)
        f.entry.files[IROH_PREBUILD_FILES[f.slot]] = createHash('sha256')
          .update(bytes)
          .digest('hex')
        f.writeManifest()
      } else {
        writeFileSync(join(f.stockDir, 'package.json'), JSON.stringify({ version: 'old' }))
      }
      await expect(ensureSourceIrohRuntime(f.input)).rejects.toThrow(
        /Patched source Iroh unavailable/
      )
      expect(existsSync(f.packageDir)).toBe(false)
    }
  )

  it('rejects stale producer identity even when an earlier stage has intact bytes', async () => {
    const f = fixture()
    const result = await ensureSourceIrohRuntime(f.input)
    const before = readFileSync(join(f.packageDir, 'package.json'))
    f.entry.iroh.recipe = 'old-recipe'
    f.writeManifest()
    await expect(ensureSourceIrohRuntime(f.input)).rejects.toThrow(/stale.*identity/)
    expect(readFileSync(result.nativePath)).toEqual(f.bytes)
    expect(readFileSync(join(f.packageDir, 'package.json'))).toEqual(before)
  })

  it.each([
    'out',
    'out/node_modules',
    'out/node_modules/@number0',
    'out/node_modules/@number0/iroh'
  ])('refuses the symlinked output ancestor %s without writing through it', async (ancestor) => {
    const f = fixture()
    // Move qualification outside out so even a symlinked out can be rejected after verification.
    const cache = join(f.root, 'qualified-cache')
    mkdirSync(dirname(join(cache, f.slot, IROH_PREBUILD_FILES[f.slot])), { recursive: true })
    writeFileSync(join(cache, f.slot, IROH_PREBUILD_FILES[f.slot]), f.bytes)
    writeFileSync(join(cache, 'manifest.json'), JSON.stringify({ slots: { [f.slot]: f.entry } }))
    rmSync(join(f.root, 'out'), { recursive: true })
    const foreign = join(f.root, 'foreign-pnpm-store')
    mkdirSync(foreign)
    const target = join(f.root, ancestor)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(foreign, target, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ensureSourceIrohRuntime({ ...f.input, prebuildsDir: cache })).rejects.toThrow(
      /checkout-owned/
    )
    expect(readdirSync(foreign)).toEqual([])
  })

  it('provisions before staging and passes the detected musl host to the existing producer', async () => {
    const f = fixture('linux-arm64-musl')
    rmSync(f.source)
    const produce = vi.spyOn(provisioner, 'ensureIrohPrebuild').mockImplementation(async () => {
      f.publish()
      return f.source
    })
    const result = await ensureSourceIrohRuntime({ ...f.input, provision: true })
    expect(produce).toHaveBeenCalledWith({
      targetPlatform: 'linux',
      arch: 'arm64',
      libc: 'musl',
      root: f.root,
      prebuildsDir: join(f.root, 'out', 'orcad-prebuilds')
    })
    expect(readFileSync(result.nativePath)).toEqual(f.bytes)
  })

  it('does not publish when a successful producer returns stale identity', async () => {
    const f = fixture()
    vi.spyOn(provisioner, 'ensureIrohPrebuild').mockImplementation(async () => {
      delete f.entry.iroh.handshakePatchSha256
      f.writeManifest()
      return f.source
    })
    await expect(ensureSourceIrohRuntime({ ...f.input, provision: true })).rejects.toThrow(
      /stale.*identity/
    )
    expect(existsSync(f.packageDir)).toBe(false)
  })

  it('keeps darwin-x64 optional without consulting a package, producer, or output directory', async () => {
    const produce = vi.spyOn(provisioner, 'ensureIrohPrebuild')
    await expect(
      ensureSourceIrohRuntime({ root: '/absent', platform: 'darwin', arch: 'x64' })
    ).resolves.toBeNull()
    expect(produce).not.toHaveBeenCalled()
  })
})

describe('readonly source Iroh checks', () => {
  it('never provisions or creates a missing stage, even with a qualified cache', async () => {
    const f = fixture()
    const produce = vi.spyOn(provisioner, 'ensureIrohPrebuild')
    await expect(
      ensureSourceIrohRuntime({ ...f.input, checkOnly: true, provision: true })
    ).rejects.toThrow(/output is missing/)
    expect(existsSync(join(f.root, 'out', 'node_modules'))).toBe(false)
    expect(produce).not.toHaveBeenCalled()
  })

  it.each(['valid', 'stale metadata', 'corrupt native', 'stale identity'])(
    'checks %s without changing existing files or invoking a producer',
    async (state) => {
      const f = fixture()
      const result = await ensureSourceIrohRuntime(f.input)
      const json = join(f.packageDir, 'package.json')
      if (state === 'stale metadata') {
        writeFileSync(json, JSON.stringify({ main: './stock.js' }))
      }
      if (state === 'corrupt native') {
        writeFileSync(result.nativePath, 'changed')
      }
      if (state === 'stale identity') {
        f.entry.iroh.sourceRevision = 'old'
        f.writeManifest()
      }
      const files = [json, result.nativePath, f.source]
      const before = files.map((path) => ({ identity: identity(path), bytes: readFileSync(path) }))
      const produce = vi.spyOn(provisioner, 'ensureIrohPrebuild')
      const check = ensureSourceIrohRuntime({ ...f.input, checkOnly: true, provision: true })
      await (state === 'valid'
        ? expect(check).resolves.toEqual(result)
        : expect(check).rejects.toThrow(/unavailable/))
      expect(
        files.map((path) => ({ identity: identity(path), bytes: readFileSync(path) }))
      ).toEqual(before)
      expect(readdirSync(f.packageDir).sort()).toEqual(
        [basename(result.nativePath), 'package.json'].sort()
      )
      expect(produce).not.toHaveBeenCalled()
    }
  )

  it('reports the host-only first-build command instead of using the installed stock SDK', async () => {
    const f = fixture()
    rmSync(f.source)
    await expect(ensureSourceIrohRuntime(f.input)).rejects.toThrow(
      /node config\/scripts\/orcad-distribution\/prebuilds\/stage-source-iroh\.mjs.*outside the pinned FHS.*rerun dev\/tests/
    )
    expect(existsSync(f.packageDir)).toBe(false)
  })
})

describe('native musl source provisioning', () => {
  it.each(['linux-x64-musl', 'linux-arm64-musl'])(
    'reuses a qualified %s cache before considering host tools',
    async (slot) => {
      const f = fixture(slot)
      const run = vi.fn()
      const ensureNode = vi.fn()
      await expect(
        provisioner.ensureIrohPrebuild({
          targetPlatform: 'linux',
          arch: f.input.arch,
          libc: 'musl',
          root: f.root,
          prebuildsDir: f.input.prebuildsDir,
          platform: 'darwin',
          hostArch: 'x64',
          run,
          ensureNode
        })
      ).resolves.toBe(f.source)
      expect(run).not.toHaveBeenCalled()
      expect(ensureNode).not.toHaveBeenCalled()
    }
  )

  it.each(['linux-x64-musl', 'linux-arm64-musl'])(
    'uses the existing native producer for missing %s bytes',
    async (slot) => {
      const f = fixture(slot)
      rmSync(f.source)
      const node = join(f.root, 'pinned-node')
      const ensureNode = vi.fn(async () => node)
      const run = vi.fn(() => {
        f.publish()
        return { status: 0 }
      })
      await expect(
        provisioner.ensureIrohPrebuild({
          targetPlatform: 'linux',
          arch: f.input.arch,
          libc: 'musl',
          root: f.root,
          prebuildsDir: f.input.prebuildsDir,
          platform: 'linux',
          hostArch: f.input.arch,
          hostLibc: 'musl',
          run,
          ensureNode
        })
      ).resolves.toBe(f.source)
      expect(run).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledWith(
        node,
        [
          join(
            f.root,
            'config',
            'scripts',
            'orcad-distribution',
            'prebuilds',
            'build-orcad-prebuilds.mjs'
          ),
          `--slot=${slot}`
        ],
        { cwd: f.root, stdio: 'inherit' }
      )
      expect(ensureNode).toHaveBeenCalledWith({
        target: slot,
        cacheDir: join(f.root, 'out', 'node-runtime-cache')
      })
    }
  )

  it.each(['foreign libc', 'cross architecture', 'custom cache'])(
    'refuses %s without invoking a musl producer',
    async (state) => {
      const f = fixture('linux-x64-musl')
      rmSync(f.source)
      const run = vi.fn()
      const ensureNode = vi.fn()
      await expect(
        provisioner.ensureIrohPrebuild({
          targetPlatform: 'linux',
          arch: 'x64',
          libc: 'musl',
          root: f.root,
          prebuildsDir:
            state === 'custom cache' ? join(f.root, 'custom-cache') : f.input.prebuildsDir,
          platform: 'linux',
          hostArch: state === 'cross architecture' ? 'arm64' : 'x64',
          hostLibc: state === 'foreign libc' ? 'glibc' : 'musl',
          run,
          ensureNode
        })
      ).rejects.toThrow(/native linux\/x64\/musl.*qualification runner/)
      expect(run).not.toHaveBeenCalled()
      expect(ensureNode).not.toHaveBeenCalled()
    }
  )

  it('reverifies a successful musl producer rather than trusting its exit status', async () => {
    const f = fixture('linux-x64-musl')
    delete f.entry.iroh.handshakePatchSha256
    f.writeManifest()
    await expect(
      provisioner.ensureIrohPrebuild({
        targetPlatform: 'linux',
        arch: 'x64',
        libc: 'musl',
        root: f.root,
        prebuildsDir: f.input.prebuildsDir,
        platform: 'linux',
        hostArch: 'x64',
        hostLibc: 'musl',
        run: () => ({ status: 0 }),
        ensureNode: async () => join(f.root, 'pinned-node')
      })
    ).rejects.toThrow(/stale.*identity/)
  })
})
