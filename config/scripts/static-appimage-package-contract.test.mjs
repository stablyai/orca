import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyStaticAppImagePackage } = require('./static-appimage-package-contract.cjs')

const RUNTIME_SOURCE = Buffer.from('https://github.com/AppImage/type2-runtime')
const LOAD_HEADER = 64
const DYNAMIC_HEADER = 120
const DYNAMIC_OFFSET = 320
const FIXTURE_BYTES = 384

describe('static AppImage package contract', () => {
  it.each([
    ['orca-linux.AppImage', 0x3e, 1],
    ['orca-linux-arm64.AppImage', 0xb7, 'arm64']
  ])('accepts a dependency-free type-2 %s runtime', async (filename, machine, targetArch) => {
    await withFixture(filename, createRuntime({ machine }), (path) => {
      expect(() => verifyStaticAppImagePackage(path, targetArch)).not.toThrow()
    })
  })

  it.each([
    ['generic filename for an arm64 runtime and target', 'orca-linux.AppImage', 0xb7, 3],
    ['arm64 filename for an x64 runtime and target', 'orca-linux-arm64.AppImage', 0x3e, 1],
    ['generic x64 runtime for an arm64 target', 'orca-linux.AppImage', 0x3e, 3],
    ['generic arm64 runtime for an x64 target', 'orca-linux.AppImage', 0xb7, 1],
    ['arm64 artifact filename for an x64 target', 'orca-linux-arm64.AppImage', 0xb7, 1],
    ['x64 runtime under an arm64 artifact filename', 'orca-linux-arm64.AppImage', 0x3e, 3]
  ])('rejects %s', async (_label, filename, machine, targetArch) => {
    await withFixture(filename, createRuntime({ machine }), (path) => {
      expect(() => verifyStaticAppImagePackage(path, targetArch)).toThrow(/architecture|target/)
    })
  })

  it.each([undefined, 0, 'ia32'])(
    'rejects unsupported target architecture %s',
    async (targetArch) => {
      await withFixture('orca-linux.AppImage', createRuntime(), (path) => {
        expect(() => verifyStaticAppImagePackage(path, targetArch)).toThrow(/target architecture/)
      })
    }
  )

  it('accepts PT_DYNAMIC relocation metadata without dependencies', async () => {
    const runtime = createRuntime()
    runtime.writeBigInt64LE(7n, DYNAMIC_OFFSET)
    await withFixture('orca-linux.AppImage', runtime, (path) => {
      expect(() => verifyStaticAppImagePackage(path, 1)).not.toThrow()
    })
  })

  it('does not scan the appended AppImage payload as outer ELF data', async () => {
    const payload = Buffer.concat([RUNTIME_SOURCE, Buffer.alloc(16, 1)])
    await withFixture('orca-linux.AppImage', Buffer.concat([createRuntime(), payload]), (path) => {
      expect(() => verifyStaticAppImagePackage(path, 1)).not.toThrow()
    })

    const unidentifiedRuntime = createRuntime()
    unidentifiedRuntime.fill(0, 192, 192 + RUNTIME_SOURCE.length)
    await withFixture(
      'orca-linux.AppImage',
      Buffer.concat([unidentifiedRuntime, payload]),
      (path) => {
        expect(() => verifyStaticAppImagePackage(path, 1)).toThrow(/does not identify/)
      }
    )
  })

  it('rejects artifact names outside the release contract before reading them', () => {
    expect(() => verifyStaticAppImagePackage('/missing/orca-preview.AppImage')).toThrow(
      'unsupported artifact name'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a readable but non-executable AppImage',
    async () => {
      await withFixture(
        'orca-linux.AppImage',
        createRuntime(),
        (path) => {
          expect(() => verifyStaticAppImagePackage(path, 1)).toThrow(/not executable/)
        },
        { mode: 0o644 }
      )
    }
  )

  it.each([
    [
      'non-ELF64 runtimes',
      (runtime) => {
        runtime[4] = 1
      },
      /ELF64 little-endian/
    ],
    [
      'unsupported ELF versions',
      (runtime) => runtime.writeUInt32LE(2, 20),
      /unsupported ELF version/
    ],
    [
      'non-type-2 AppImages',
      (runtime) => {
        runtime[10] = 1
      },
      /type-2 AppImage marker/
    ],
    ['non-PIE runtimes', (runtime) => runtime.writeUInt16LE(2, 16), /ET_DYN static PIE/],
    [
      'unsupported architectures',
      (runtime) => runtime.writeUInt16LE(3, 18),
      /unsupported ELF machine/
    ],
    ['dynamic loaders', (runtime) => runtime.writeUInt32LE(3, DYNAMIC_HEADER), /PT_INTERP/],
    [
      'shared-library dependencies',
      (runtime) => runtime.writeBigInt64LE(1n, DYNAMIC_OFFSET),
      /DT_NEEDED/
    ],
    [
      'unidentified runtimes',
      (runtime) => runtime.fill(0, 192, 192 + RUNTIME_SOURCE.length),
      /does not identify/
    ],
    [
      'out-of-bounds load segments',
      (runtime) => {
        runtime.writeBigUInt64LE(1000n, LOAD_HEADER + 32)
        runtime.writeBigUInt64LE(1000n, LOAD_HEADER + 40)
      },
      /outside the artifact/
    ],
    [
      'oversized load claims',
      (runtime) => {
        runtime.writeBigUInt64LE(16n * 1024n * 1024n + 1n, LOAD_HEADER + 32)
        runtime.writeBigUInt64LE(16n * 1024n * 1024n + 1n, LOAD_HEADER + 40)
      },
      /oversized PT_LOAD/
    ],
    [
      'non-executable entry segments',
      (runtime) => runtime.writeUInt32LE(4, LOAD_HEADER + 4),
      /executable PT_LOAD/
    ],
    [
      'entry points outside load segments',
      (runtime) => runtime.writeBigUInt64LE(4096n, 24),
      /entry point/
    ]
  ])('rejects %s', async (_label, mutate, expected) => {
    const runtime = createRuntime()
    mutate(runtime)
    await withFixture('orca-linux.AppImage', runtime, (path) => {
      expect(() => verifyStaticAppImagePackage(path, 1)).toThrow(expected)
    })
  })
})

function createRuntime({ machine = 0x3e } = {}) {
  const runtime = Buffer.alloc(FIXTURE_BYTES)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(runtime)
  Buffer.from([0x41, 0x49, 0x02]).copy(runtime, 8)
  runtime.writeUInt16LE(3, 16)
  runtime.writeUInt16LE(machine, 18)
  runtime.writeUInt32LE(1, 20)
  runtime.writeBigUInt64LE(0n, 24)
  runtime.writeBigUInt64LE(64n, 32)
  runtime.writeUInt16LE(64, 52)
  runtime.writeUInt16LE(56, 54)
  runtime.writeUInt16LE(2, 56)

  writeProgramHeader(runtime, LOAD_HEADER, {
    type: 1,
    flags: 5,
    offset: 0,
    virtualAddress: 0,
    size: FIXTURE_BYTES,
    memorySize: FIXTURE_BYTES,
    alignment: 4096
  })
  writeProgramHeader(runtime, DYNAMIC_HEADER, {
    type: 2,
    flags: 4,
    offset: DYNAMIC_OFFSET,
    virtualAddress: DYNAMIC_OFFSET,
    size: 32,
    memorySize: 32,
    alignment: 8
  })
  RUNTIME_SOURCE.copy(runtime, 192)
  return runtime
}

function writeProgramHeader(
  runtime,
  headerOffset,
  { type, flags, offset, virtualAddress, size, memorySize = size, alignment }
) {
  runtime.writeUInt32LE(type, headerOffset)
  runtime.writeUInt32LE(flags, headerOffset + 4)
  runtime.writeBigUInt64LE(BigInt(offset), headerOffset + 8)
  runtime.writeBigUInt64LE(BigInt(virtualAddress), headerOffset + 16)
  runtime.writeBigUInt64LE(BigInt(offset), headerOffset + 24)
  runtime.writeBigUInt64LE(BigInt(size), headerOffset + 32)
  runtime.writeBigUInt64LE(BigInt(memorySize), headerOffset + 40)
  runtime.writeBigUInt64LE(BigInt(alignment), headerOffset + 48)
}

async function withFixture(filename, contents, check, { mode = 0o755 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-static-appimage-contract-'))
  try {
    const path = join(root, filename)
    await writeFile(path, contents)
    await chmod(path, mode)
    await check(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
