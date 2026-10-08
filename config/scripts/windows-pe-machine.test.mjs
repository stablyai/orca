import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { peImage } from './windows-pe-image-fixture.mjs'

const require = createRequire(import.meta.url)
const { PE_MACHINE, describePeMachine, readPeMachine } = require('./windows-pe-machine.cjs')

const fixtureDir = mkdtempSync(join(tmpdir(), 'windows-pe-machine-'))

function writeImage(name, build) {
  const path = join(fixtureDir, name)
  writeFileSync(path, build())
  return path
}

const X64 = writeImage('x64.node', () => peImage({ machine: PE_MACHINE.x64 }))
const ARM64 = writeImage('arm64.node', () => peImage({ machine: PE_MACHINE.arm64 }))

describe('PE_MACHINE', () => {
  // Spelled out rather than taken from the module: the fixtures below build
  // their headers from these, so a table that is wrong in both entries would
  // otherwise agree with itself.
  it('holds the IMAGE_FILE_MACHINE values Windows actually stamps', () => {
    expect(PE_MACHINE).toEqual({ x64: 0x8664, arm64: 0xaa64 })
  })
})

describe('readPeMachine', () => {
  it.each([
    ['x64', X64, PE_MACHINE.x64],
    ['arm64', ARM64, PE_MACHINE.arm64]
  ])('reads the machine field of a %s image', (_case, path, expected) => {
    expect(readPeMachine(path)).toBe(expected)
  })

  // Callers ask this of files they did not produce, so anything that is not a
  // PE has to be an answer rather than a crash.
  it.each([
    ['a Mach-O or ELF binary', () => Buffer.alloc(0x200)],
    ['a file too short to hold a DOS header', () => Buffer.from('MZ')],
    [
      'a DOS stub whose PE offset points nowhere',
      () => peImage({ machine: 0x8664, peOffset: 0x8000 }).subarray(0, 0x88)
    ],
    ['a file with no PE signature', () => peImage({ machine: 0x8664, signature: 'XX\0\0' })]
  ])('returns null for %s', (_case, build) => {
    expect(readPeMachine(writeImage(`not-pe-${Math.random()}.bin`, build))).toBeNull()
  })

  it('respects the DOS header pointer rather than a fixed offset', () => {
    const path = writeImage('shifted.node', () =>
      peImage({ machine: PE_MACHINE.arm64, peOffset: 0x120 })
    )
    expect(readPeMachine(path)).toBe(PE_MACHINE.arm64)
  })
})

describe('peImage fixture', () => {
  // A fixture that quietly stamps machine 0x0000 for an arch it does not know
  // is the same species of silent lie these gates exist to catch.
  it('refuses to invent a machine value for an arch it has none for', () => {
    expect(() => peImage({ arch: 'ia32' })).toThrow(/must not invent one/)
  })

  it('still takes an explicit machine, which is how the non-PE cases are built', () => {
    expect(readPeMachine(writeImage('explicit.node', () => peImage({ machine: 0x1234 })))).toBe(
      0x1234
    )
  })
})

describe('describePeMachine', () => {
  // The callers put this straight into an error, and "not a PE image" is a
  // different problem from a cross-arch build.
  it('names a machine field it read', () => {
    expect(describePeMachine(PE_MACHINE.arm64)).toBe('machine 0xaa64')
  })

  it('says so when there was none, rather than throwing on null', () => {
    expect(describePeMachine(null)).toBe('not a PE image')
  })
})
