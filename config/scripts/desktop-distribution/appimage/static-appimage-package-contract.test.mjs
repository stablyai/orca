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
