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
  gitSpawnAfterWindowsEnvironmentReady: gitSpawnMock
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
      .mockResolvedValueOnce(revParse)
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(ignored)

    const promise = listFilesWithGit(root, [], { wslDistro: 'Ubuntu' })
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(revParse.listenerCount('close')).toBeGreaterThan(0))
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
    expect(gitSpawnMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ admissionTier: 'interactive', wslDistro: 'Ubuntu' })
    )
    expect(gitSpawnMock.mock.calls[2][1]).toEqual(
      expect.objectContaining({ admissionTier: 'interactive', wslDistro: 'Ubuntu' })
    )
    expect(gitSpawnMock.mock.calls[2][0]).toContain('--directory')
  })

  it('cancels both local Git passes when Quick Open abandons the request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-main-git-cancel-'))
    tempDirs.push(root)
    const revParse = createMockProcess()
    const primary = createMockProcess()
    const ignored = createMockProcess()
    gitSpawnMock
      .mockResolvedValueOnce(revParse)
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(ignored)

    const controller = new AbortController()
    const promise = listFilesWithGit(root, [], {}, controller.signal)
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(revParse.listenerCount('close')).toBeGreaterThan(0))
    revParse.emit('close', 0, null)
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledTimes(3))
    controller.abort()

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(primary.kill).toHaveBeenCalled()
    expect(ignored.kill).toHaveBeenCalled()
  })

  it('kills a repository probe returned after cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-main-git-probe-race-'))
    tempDirs.push(root)
    const revParse = createMockProcess()
    let resolveRevParse!: (child: ChildProcess) => void
    gitSpawnMock.mockReturnValueOnce(
      new Promise<ChildProcess>((resolve) => {
        resolveRevParse = resolve
      })
    )

    const controller = new AbortController()
    const promise = listFilesWithGit(root, [], {}, controller.signal)
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledOnce())
    controller.abort()
    resolveRevParse(revParse)

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(revParse.kill).toHaveBeenCalled()
    expect(revParse.listenerCount('close')).toBe(0)
  })

  it('kills file scans returned after cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-main-git-scan-race-'))
    tempDirs.push(root)
    const revParse = createMockProcess()
    const primary = createMockProcess()
    const ignored = createMockProcess()
    let resolvePrimary!: (child: ChildProcess) => void
    let resolveIgnored!: (child: ChildProcess) => void
    gitSpawnMock
      .mockResolvedValueOnce(revParse)
      .mockReturnValueOnce(
        new Promise<ChildProcess>((resolve) => {
          resolvePrimary = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise<ChildProcess>((resolve) => {
          resolveIgnored = resolve
        })
      )

    const controller = new AbortController()
    const promise = listFilesWithGit(root, [], {}, controller.signal)
    await vi.waitFor(() => expect(revParse.listenerCount('close')).toBeGreaterThan(0))
    revParse.emit('close', 0, null)
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledTimes(3))
    controller.abort()
    resolvePrimary(primary)
    resolveIgnored(ignored)

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(primary.kill).toHaveBeenCalled()
    expect(ignored.kill).toHaveBeenCalled()
  })

  it('cancels a pending sibling spawn when the primary scan fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-main-git-sibling-failure-'))
    tempDirs.push(root)
    const revParse = createMockProcess()
    const primary = createMockProcess()
    let pendingSignal: AbortSignal | undefined
    gitSpawnMock
      .mockResolvedValueOnce(revParse)
      .mockResolvedValueOnce(primary)
      .mockImplementationOnce(
        (_args: string[], options: { signal?: AbortSignal }) =>
          new Promise<ChildProcess>((_resolve, reject) => {
            pendingSignal = options.signal
            options.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true }
            )
          })
      )

    const promise = listFilesWithGit(root, [], {})
    await vi.waitFor(() => expect(revParse.listenerCount('close')).toBeGreaterThan(0))
    revParse.emit('close', 0, null)
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledTimes(3))
    primary.emit('error', new Error('primary failed'))

    await expect(promise).rejects.toThrow('primary failed')
    expect(pendingSignal?.aborted).toBe(true)
  })
})
