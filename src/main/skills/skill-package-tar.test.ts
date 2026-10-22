import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openSkillTarGzip,
  parseSkillTarHeader,
  SKILL_TAR_BLOCK_BYTES,
  writeSkillTarGzip
} from './skill-package-tar'

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function refreshChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
}

function header(type = '0'): Buffer {
  const value = Buffer.alloc(SKILL_TAR_BLOCK_BYTES)
  value.write('skill/SKILL.md', 0, 'utf8')
  writeOctal(value, 100, 8, 0o644)
  writeOctal(value, 108, 8, 0)
  writeOctal(value, 116, 8, 0)
  writeOctal(value, 124, 12, 0)
  writeOctal(value, 136, 12, 0)
  value[156] = type.charCodeAt(0)
  value.write('ustar\0', 257, 'ascii')
  value.write('00', 263, 'ascii')
  refreshChecksum(value)
  return value
}

describe('skill package tar envelope', () => {
  it.each(['1', '2', '3', '4', '5', '6', '7', 'x', 'g', 'L', 'K', 's'])(
    'rejects non-regular tar entry type %s',
    (type) => {
      expect(() => parseSkillTarHeader(header(type))).toThrow('skill-package-tar-entry-type')
    }
  )

  it('requires the deterministic ustar dialect', () => {
    const legacy = header()
    legacy.fill(0, 257, 265)
    refreshChecksum(legacy)
    expect(() => parseSkillTarHeader(legacy)).toThrow('skill-package-tar-format-invalid')
  })

  it('fuzzes fixed-size headers without unbounded parsing or non-Error failures', () => {
    let state = 0x51a7e
    const randomByte = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state & 0xff
    }
    for (let sample = 0; sample < 5_000; sample += 1) {
      const value = Buffer.allocUnsafe(SKILL_TAR_BLOCK_BYTES)
      for (let index = 0; index < value.length; index += 1) {
        value[index] = randomByte()
      }
      refreshChecksum(value)
      try {
        const parsed = parseSkillTarHeader(value)
        expect(parsed === null || Buffer.byteLength(parsed.path, 'utf8') <= 256).toBe(true)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
    }
  })
})

describe('skill tar reader error ownership', () => {
  it('observes an abort after the pipeline completes before the first reader request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-tar-abort-'))
    try {
      const archivePath = join(root, 'archive.tar.gz')
      await writeSkillTarGzip(archivePath, [
        { path: 'SKILL.md', size: 1, executable: false, bytes: Buffer.from('x') }
      ])
      const archive = await openSkillTarGzip(archivePath)
      await archive.archiveIdentity
      const failure = Object.assign(new Error('staging directory already exists'), {
        code: 'EEXIST'
      })
      archive.abort(failure)
      // Observe destruction before lazily attaching the reader's error listener.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await expect(archive.reader.readExact(SKILL_TAR_BLOCK_BYTES)).rejects.toBe(failure)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
