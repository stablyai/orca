import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { giveMacMainExecutableUniqueUuid } = require('./macos-executable-uuid.cjs')

const ARM64 = 0x0100000c
const X86_64 = 0x01000007
const STOCK_UUID = Buffer.from('4C4C44C055553144A1E0C291B44FDBE3', 'hex')

function thinSlice(cpuType) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpuType, 4)
  header.writeUInt32LE(2, 12)
  header.writeUInt32LE(2, 16)
  header.writeUInt32LE(16 + 24, 20)
  const other = Buffer.alloc(16, 0xaa)
  other.writeUInt32LE(0x19, 0)
  other.writeUInt32LE(16, 4)
  const uuid = Buffer.alloc(24)
  uuid.writeUInt32LE(0x1b, 0)
  uuid.writeUInt32LE(24, 4)
  STOCK_UUID.copy(uuid, 8)
  return Buffer.concat([header, other, uuid, Buffer.alloc(8, 0xbb)])
}

function fatBinary(slices) {
  const table = Buffer.alloc(8 + slices.length * 20)
  table.writeUInt32BE(0xcafebabe, 0)
  table.writeUInt32BE(slices.length, 4)
  const parts = [table]
  let offset = 4096
  slices.forEach((slice, i) => {
    table.writeUInt32BE(slice.readUInt32LE(4), 8 + i * 20)
    table.writeUInt32BE(offset, 8 + i * 20 + 8)
    table.writeUInt32BE(slice.length, 8 + i * 20 + 12)
    const end = parts.reduce((n, p) => n + p.length, 0)
    parts.push(Buffer.alloc(offset - end), slice)
    offset += 4096
  })
  return Buffer.concat(parts)
}

function withApp(executable, run) {
  const app = join(mkdtempSync(join(tmpdir(), 'orca-exe-uuid-')), 'Orca.app')
  try {
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    const path = join(app, 'Contents', 'MacOS', 'Orca')
    writeFileSync(path, executable)
    run(app, path)
  } finally {
    rmSync(join(app, '..'), { recursive: true, force: true })
  }
}

const uuidAt = (buffer, offset) => buffer.subarray(offset, offset + 16).toString('hex')

describe('giveMacMainExecutableUniqueUuid', () => {
  it('replaces the stock UUID of a thin executable and nothing else', () => {
    const original = thinSlice(ARM64)
    withApp(original, (app, path) => {
      giveMacMainExecutableUniqueUuid(app, 'com.stablyai.orca', 'Orca')
      const rewritten = readFileSync(path)
      expect(uuidAt(rewritten, 56)).toBe('e64304103b228bd69677b18884034a30')
      expect(Buffer.concat([rewritten.subarray(0, 56), rewritten.subarray(72)])).toEqual(
        Buffer.concat([original.subarray(0, 56), original.subarray(72)])
      )
    })
  })

  it('gives every slice of a universal executable its own stable UUID', () => {
    withApp(fatBinary([thinSlice(X86_64), thinSlice(ARM64)]), (app, path) => {
      giveMacMainExecutableUniqueUuid(app, 'com.stablyai.orca', 'Orca')
      giveMacMainExecutableUniqueUuid(app, 'com.stablyai.orca', 'Orca')
      const rewritten = readFileSync(path)
      expect(uuidAt(rewritten, 4096 + 56)).toBe('016ee6813dc381c7a6da12dc23b89dd9')
      expect(uuidAt(rewritten, 8192 + 56)).toBe('e64304103b228bd69677b18884034a30')
    })
  })

  it('refuses an executable without LC_UUID', () => {
    const slice = thinSlice(ARM64)
    slice.writeUInt32LE(0x1a, 48)
    withApp(slice, (app) => {
      expect(() => giveMacMainExecutableUniqueUuid(app, 'com.stablyai.orca', 'Orca')).toThrow(
        'has no LC_UUID'
      )
    })
  })
})
