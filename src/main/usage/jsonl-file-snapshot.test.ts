import { mkdtemp, open, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonlFileSnapshot, readJsonlHandleSnapshot } from './jsonl-file-snapshot'

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
})
