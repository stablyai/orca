import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { gitSpawnMock } = vi.hoisted(() => ({
  gitSpawnMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitSpawn: gitSpawnMock
}))

import { listFilesWithGit } from './filesystem-list-files-git-fallback'
import { isFileListingCancellation } from '../../shared/file-listing-cancellation'

const tempDirs: string[] = []
const SHA1 = '0123456789abcdef0123456789abcdef01234567'

function createMockProcess(): ChildProcess {
  const process = new EventEmitter() as unknown as ChildProcess
  ;(process as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (process as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(process as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(process as unknown as Record<string, unknown>).kill = vi.fn()
  ;(process as unknown as Record<string, unknown>).exitCode = null
  ;(process as unknown as Record<string, unknown>).signalCode = null
  return process
}

async function writeRel(root: string, relPath: string): Promise<void> {
  const absPath = join(root, ...relPath.split('/'))
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, 'x')
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('main Quick Open git directory expansion', () => {
  it('expands placeholders emitted by both directory-collapsing passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-main-git-ignored-dir-'))
    tempDirs.push(root)
    await writeRel(root, 'dist/generated.js')
    await writeRel(root, 'scratch/notes.txt')

    const revParse = createMockProcess()
    const primary = createMockProcess()
    const ignored = createMockProcess()
    gitSpawnMock
      .mockReturnValueOnce(revParse)
      .mockReturnValueOnce(primary)
      .mockReturnValueOnce(ignored)

    const promise = listFilesWithGit(root, [], {})
    revParse.emit('close', 0, null)
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledTimes(3))
    ;(primary.stdout as unknown as EventEmitter).emit(
      'data',
      `100644 ${SHA1} 0\tsrc/index.ts\0scratch/\0`
    )
    primary.emit('close', 0, null)
    ;(ignored.stdout as unknown as EventEmitter).emit('data', 'dist/\0')
    ignored.emit('close', 0, null)

    await expect(promise).resolves.toEqual([
      'dist/generated.js',
      'scratch/notes.txt',
      'src/index.ts'
    ])
    expect(gitSpawnMock.mock.calls[2][0]).toContain('--directory')
  })

  it('cancels both local Git passes when Quick Open abandons the request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-main-git-cancel-'))
    tempDirs.push(root)
    const revParse = createMockProcess()
    const primary = createMockProcess()
    const ignored = createMockProcess()
    gitSpawnMock
      .mockReturnValueOnce(revParse)
      .mockReturnValueOnce(primary)
      .mockReturnValueOnce(ignored)

    const controller = new AbortController()
    const promise = listFilesWithGit(root, [], {}, controller.signal)
    revParse.emit('close', 0, null)
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledTimes(3))
    controller.abort()

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(primary.kill).toHaveBeenCalled()
    expect(ignored.kill).toHaveBeenCalled()
  })
})
