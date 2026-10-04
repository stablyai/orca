import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsync = vi.hoisted(() => vi.fn())
const isGitRepo = vi.hoisted(() => vi.fn())
const rm = vi.hoisted(() => vi.fn())

vi.mock('./runner', () => ({ gitExecFileAsync }))
vi.mock('./repo', () => ({ isGitRepo }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  rm
}))

import { convertLocalFolderToGit } from './convert-local-folder-to-git'

describe('convertLocalFolderToGit cleanup ownership', () => {
  let folderPath: string

  beforeEach(() => {
    folderPath = mkdtempSync(join(tmpdir(), 'orca-local-convert-'))
    gitExecFileAsync.mockReset()
    isGitRepo.mockReset()
    isGitRepo.mockReturnValue(false)
    rm.mockReset()
    rm.mockImplementation(async (path: string) => {
      rmSync(path, { recursive: true, force: true })
    })
  })

  afterEach(() => {
    rmSync(folderPath, { recursive: true, force: true })
  })

  function failCommitAfterInit(): void {
    gitExecFileAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'init') {
        mkdirSync(join(folderPath, '.git'), { recursive: true })
      }
      if (args[0] === 'commit') {
        throw new Error('commit failed')
      }
    })
  }

  it('preserves repository metadata that existed before conversion', async () => {
    mkdirSync(join(folderPath, '.git'))
    failCommitAfterInit()

    await expect(convertLocalFolderToGit(folderPath)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('commit failed')
    })

    expect(existsSync(join(folderPath, '.git'))).toBe(true)
  })

  it('removes repository metadata created by a failed conversion', async () => {
    failCommitAfterInit()

    await expect(convertLocalFolderToGit(folderPath)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('commit failed')
    })

    expect(existsSync(join(folderPath, '.git'))).toBe(false)
  })

  it('removes partial repository metadata left by a failed git init', async () => {
    gitExecFileAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'init') {
        mkdirSync(join(folderPath, '.git'), { recursive: true })
        throw new Error('init failed')
      }
    })

    await expect(convertLocalFolderToGit(folderPath)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('init failed')
    })

    expect(existsSync(join(folderPath, '.git'))).toBe(false)
  })

  it('reports the conversion and cleanup failures together', async () => {
    failCommitAfterInit()
    rm.mockRejectedValueOnce(new Error('permission denied'))

    await expect(convertLocalFolderToGit(folderPath)).resolves.toEqual({
      ok: false,
      error:
        'Failed to create initial commit: commit failed. Failed to remove partial Git metadata: permission denied'
    })

    expect(existsSync(join(folderPath, '.git'))).toBe(true)
  })
})
