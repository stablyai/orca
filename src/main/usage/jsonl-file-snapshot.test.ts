import { mkdtemp, open, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeJsonlFileSnapshot,
  readJsonlFileSnapshot,
  readJsonlHandleSnapshot,
  sameJsonlFileSnapshot
} from './jsonl-file-snapshot'

let directory: string
let filePath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-jsonl-snapshot-'))
  filePath = join(directory, 'transcript.jsonl')
  await writeFile(filePath, 'one\n')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('JSONL file snapshot normalization', () => {
  it.each(['dev', 'ino'] as const)(
    'distinguishes exact %s identifiers that collide as JavaScript numbers',
    async (field) => {
      const stats = await stat(filePath, { bigint: true })
      const lower = { ...stats, [field]: 9_007_199_254_740_992n }
      const upper = { ...stats, [field]: 9_007_199_254_740_993n }

      expect(Number(lower[field])).toBe(Number(upper[field]))
      expect(normalizeJsonlFileSnapshot(lower)[field]).not.toBe(
        normalizeJsonlFileSnapshot(upper)[field]
      )
      expect(
        sameJsonlFileSnapshot(normalizeJsonlFileSnapshot(lower), normalizeJsonlFileSnapshot(upper))
      ).toBe(false)
    }
  )

  it.each([0.123456789, 1.999999999, 1_784_029_260.125, 2_147_483_647.875])(
    'preserves numeric stat timestamps at fractional epoch seconds %s',
    async (seconds) => {
      await utimes(filePath, seconds, seconds)
      const numeric = await stat(filePath)
      const snapshot = await readJsonlFileSnapshot(filePath)
      const handle = await open(filePath, 'r')
      try {
        expect(snapshot.mtimeMs).toBe(numeric.mtimeMs)
        expect(snapshot.ctimeMs).toBe(numeric.ctimeMs)
        expect(snapshot.size).toBe(numeric.size)
        expect(await readJsonlHandleSnapshot(handle)).toEqual(snapshot)
      } finally {
        await handle.close()
      }
    }
  )

  it('retains fractional nanoseconds instead of truncating bigint milliseconds', async () => {
    const stats = await stat(filePath, { bigint: true })
    const snapshot = normalizeJsonlFileSnapshot({
      ...stats,
      mtimeNs: 1_784_029_260_123_456_789n,
      ctimeNs: 1_784_029_260_987_654_321n
    })

    expect(snapshot.mtimeMs).toBe(1_784_029_260_000 + 123.456789)
    expect(snapshot.ctimeMs).toBe(1_784_029_260_000 + 987.654321)
    expect(snapshot.mtimeMs).not.toBe(1_784_029_260_123)
    expect(snapshot.ctimeMs).not.toBe(1_784_029_260_987)
  })

  it('accepts zero and the largest safe byte offset', async () => {
    const stats = await stat(filePath, { bigint: true })

    expect(normalizeJsonlFileSnapshot({ ...stats, size: 0n }).size).toBe(0)
    expect(
      normalizeJsonlFileSnapshot({ ...stats, size: BigInt(Number.MAX_SAFE_INTEGER) }).size
    ).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each([-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1n << 1024n])(
    'rejects a file size that is not a safe byte offset: %s',
    async (size) => {
      const stats = await stat(filePath, { bigint: true })

      expect(() => normalizeJsonlFileSnapshot({ ...stats, size })).toThrow(/safe byte offset/)
    }
  )
})
