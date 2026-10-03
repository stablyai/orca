import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fsPromises = vi.hoisted(() => ({ rm: vi.fn(), rename: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  fsPromises.rm.mockImplementation(actual.rm)
  fsPromises.rename.mockImplementation(actual.rename)
  return { ...actual, rm: fsPromises.rm, rename: fsPromises.rename }
})

import { durableWriteTempPath, writeFileProcessDurable } from './durable-file-write'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-process-durable-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  fsPromises.rm.mockClear()
  fsPromises.rename.mockClear()
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe('writeFileProcessDurable', () => {
  // The temp file is gone once renamed; removing it again is a wasted file-system call.
  it('renames the temp file into place without removing it afterwards', async () => {
    const file = join(tempDir(), 'draft.json')

    await writeFileProcessDurable(durableWriteTempPath(file), file, '{"a":1}')

    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
    expect(fsPromises.rm).not.toHaveBeenCalled()
  })

  it('removes the temp file when the rename fails', async () => {
    const dir = tempDir()
    const file = join(dir, 'draft.json')
    fsPromises.rename.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))

    await expect(
      writeFileProcessDurable(durableWriteTempPath(file), file, '{"a":1}')
    ).rejects.toThrow('denied')
    expect(readdirSync(dir)).toEqual([])
  })
})
