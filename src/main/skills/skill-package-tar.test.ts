import type * as NodeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type * as NodeZlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  parseSkillTarHeader,
  readSkillTarGzip,
  SKILL_TAR_BLOCK_BYTES,
  writeSkillTarGzip
} from './skill-package-tar'

const readStreams = vi.hoisted(() => {
  const streams: { source?: NodeFs.ReadStream; gunzip?: NodeZlib.Gunzip } = {}
  return streams
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      readStreams.source = actual.createReadStream(...args)
      return readStreams.source
    }
  }
})

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeZlib>()
  return {
    ...actual,
    createGunzip: (options?: NodeZlib.ZlibOptions) => {
      readStreams.gunzip = actual.createGunzip(options)
      return readStreams.gunzip
    }
  }
})

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

  it('reads a small archive and reports the identity it was written with', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-tar-read-'))
    try {
      const archivePath = join(root, 'small.tar.gz')
      const bytes = Buffer.from('# Small\n')
      const written = await writeSkillTarGzip(archivePath, [
        { path: 'SKILL.md', size: bytes.length, executable: false, bytes }
      ])

      const read = await readSkillTarGzip(archivePath, async (reader) => {
        const entry = parseSkillTarHeader(await reader.readExact(SKILL_TAR_BLOCK_BYTES))
        const content = await reader.readExact(bytes.length)
        while (await reader.readExactOrNull(1)) {
          // Drain padding and the end-of-archive blocks.
        }
        return { entry, content: content.toString('utf8') }
      })

      expect(read).toEqual({
        value: {
          entry: { path: 'SKILL.md', size: bytes.length, executable: false },
          content: '# Small\n'
        },
        ...written
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([0, 1])(
    'rejects with the consumer failure and leaks no uncaught error after reading %i blocks of a fully inflated archive',
    async (blocksRead) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-skill-tar-fail-'))
      const uncaught: unknown[] = []
      const record = (error: unknown): void => {
        uncaught.push(error)
      }
      process.on('uncaughtException', record)
      try {
        const archivePath = join(root, 'small.tar.gz')
        const bytes = Buffer.from('# Small\n')
        await writeSkillTarGzip(archivePath, [
          { path: 'SKILL.md', size: bytes.length, executable: false, bytes }
        ])
        const failure = new Error('caller-failed-after-read')

        await expect(
          readSkillTarGzip(archivePath, async (reader) => {
            for (let block = 0; block < blocksRead; block += 1) {
              await reader.readExact(SKILL_TAR_BLOCK_BYTES)
            }
            const { source, gunzip } = readStreams
            if (!source || !gunzip) {
              throw new Error('read-streams-not-captured')
            }
            // A slow caller (e.g. a Windows mkdir) fails after the file is read and inflated but not yet drained.
            // cleanup: a lingering 'error' listener from this wait would absorb the leak under test.
            await Promise.all([
              finished(source, { cleanup: true }),
              finished(gunzip, { readable: false, cleanup: true })
            ])
            await new Promise<void>((resolve) => setImmediate(resolve))
            throw failure
          })
        ).rejects.toBe(failure)
        await new Promise<void>((resolve) => setImmediate(resolve))

        expect(uncaught).toEqual([])
      } finally {
        process.off('uncaughtException', record)
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
