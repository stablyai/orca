import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectNativeExecutable, PE_MACHINE, readPeMachine } from './native-executable-format.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture(name, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'native-executable-format-'))
  temporaryDirectories.push(dir)
  const path = join(dir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, bytes)
  return path
}

function elf(machine, interpreter = null) {
  const interpreterBytes = interpreter ? Buffer.from(`${String(interpreter)}\0`) : Buffer.alloc(0)
  const bytes = Buffer.alloc(64 + 56 + interpreterBytes.length)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes)
  bytes[4] = 2
  bytes[5] = 1
  bytes.writeUInt16LE(machine, 18)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(interpreter ? 1 : 0, 56)
  if (interpreter) {
    bytes.writeUInt32LE(3, 64)
    bytes.writeBigUInt64LE(120n, 72)
    bytes.writeBigUInt64LE(BigInt(interpreterBytes.length), 96)
    interpreterBytes.copy(bytes, 120)
  }
  return bytes
}

function macho(cpu) {
  const bytes = Buffer.alloc(8)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(cpu, 4)
  return bytes
}

function pe(machine) {
  const bytes = Buffer.alloc(134)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(128, 0x3c)
  bytes.write('PE\0\0', 128, 'binary')
  bytes.writeUInt16LE(machine, 132)
  return bytes
}

describe('native executable format inspection', () => {
  it('reads ELF architecture and the glibc or musl interpreter', () => {
    expect(
      inspectNativeExecutable(fixture('linux-x64', elf(0x3e, '/lib64/ld-linux.so.2')))
    ).toEqual({
      format: 'elf',
      arch: 'x64',
      machine: 0x3e,
      interpreter: '/lib64/ld-linux.so.2'
    })
    expect(
      inspectNativeExecutable(fixture('linux-arm64', elf(0xb7, '/lib/ld-musl-aarch64.so.1')))
    ).toMatchObject({ format: 'elf', arch: 'arm64', interpreter: '/lib/ld-musl-aarch64.so.1' })
  })

  it('reads thin 64-bit Mach-O architecture', () => {
    expect(inspectNativeExecutable(fixture('darwin-arm64', macho(0x0100000c)))).toMatchObject({
      format: 'macho',
      arch: 'arm64'
    })
    expect(inspectNativeExecutable(fixture('darwin-x64', macho(0x01000007)))).toMatchObject({
      format: 'macho',
      arch: 'x64'
    })
  })

  it('reuses exact PE machine parsing for x64 and arm64', () => {
    const x64 = fixture('win32-x64', pe(PE_MACHINE.x64))
    const arm64 = fixture('win32-arm64', pe(PE_MACHINE.arm64))
    expect(inspectNativeExecutable(x64)).toMatchObject({ format: 'pe', arch: 'x64' })
    expect(readPeMachine(arm64)).toBe(PE_MACHINE.arm64)
  })

  it('rejects unknown and truncated formats', () => {
    expect(() => inspectNativeExecutable(fixture('unknown', Buffer.from('text')))).toThrow(
      'not a supported ELF, Mach-O, or PE executable'
    )
    expect(() => inspectNativeExecutable(fixture('truncated', Buffer.from('MZ')))).toThrow(
      'truncated DOS header'
    )
    const truncatedMach = Buffer.alloc(4)
    truncatedMach.writeUInt32LE(0xfeedfacf)
    expect(() => inspectNativeExecutable(fixture('truncated-mach', truncatedMach))).toThrow(
      'truncated Mach-O header'
    )
  })
})
