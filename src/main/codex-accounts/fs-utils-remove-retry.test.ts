import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fsPromises = vi.hoisted(() => ({ rm: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  fsPromises.rm.mockImplementation(actual.rm)
  return { ...actual, rm: fsPromises.rm }
})

import { removeFileWithWindowsRetryAsync } from './fs-utils'

const originalPlatform = process.platform
const dirs: string[] = []

function fileInTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-fs-remove-retry-'))
  dirs.push(dir)
  const file = join(dir, 'draft.json')
  writeFileSync(file, '{}')
  return file
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  fsPromises.rm.mockClear()
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe('removeFileWithWindowsRetryAsync', () => {
  // An antivirus scan holding the file open must not fail the delete (#1507).
  it('retries a Windows sharing violation', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const file = fileInTempDir()
    fsPromises.rm.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))

    await removeFileWithWindowsRetryAsync(file)

    expect(fsPromises.rm).toHaveBeenCalledTimes(2)
    expect(existsSync(file)).toBe(false)
  })

  it('treats a missing file as deleted', async () => {
    const file = fileInTempDir()
    await removeFileWithWindowsRetryAsync(file)
    await expect(removeFileWithWindowsRetryAsync(file)).resolves.toBeUndefined()
  })

  it('does not retry off Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    fsPromises.rm.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))

    await expect(removeFileWithWindowsRetryAsync(fileInTempDir())).rejects.toThrow('busy')
    expect(fsPromises.rm).toHaveBeenCalledOnce()
  })
})
