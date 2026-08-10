import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completedRecordEnd } from './transcript-tail-reader'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function fixture(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-completed-record-end-'))
  tempRoots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, content)
  return filePath
}

describe('completedRecordEnd', () => {
  it('returns the file end when the last record is complete', async () => {
    const filePath = await fixture('{"a":1}\n{"b":2}\n')

    await expect(completedRecordEnd(filePath, 16)).resolves.toBe(16)
  })

  it('stops before a half-written record', async () => {
    const filePath = await fixture('{"a":1}\n{"b":2}')

    await expect(completedRecordEnd(filePath, 15)).resolves.toBe(8)
  })

  it('returns 0 for an empty file without opening it', async () => {
    const filePath = await fixture('')

    await expect(completedRecordEnd(filePath, 0)).resolves.toBe(0)
  })

  it('clamps to the live size when the file shrank under the caller stat', async () => {
    // The caller stats separately, so `end` can point past EOF. Probing there
    // reads an uninitialized buffer, which could report a cursor beyond the file
    // and make every later poll re-window.
    const filePath = await fixture('{"a":1}\n{"b":2}\n')
    await truncate(filePath, 8)

    await expect(completedRecordEnd(filePath, 16)).resolves.toBe(8)
  })

  it('rejects when the file is gone, which is why callers guard the probe', async () => {
    const filePath = await fixture('{"a":1}\n')
    await rm(filePath)

    await expect(completedRecordEnd(filePath, 8)).rejects.toThrow()
  })
})
