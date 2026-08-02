/**
 * Cancellation behavior of the relay file-list scanners (#7721): an aborted
 * scan must kill its child processes immediately and reject with a
 * cancellation error instead of streaming an abandoned tree to completion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { listFilesWithRg } from './fs-handler-list-files'
import { listFilesWithGit } from './fs-handler-git-fallback'
import { isFileListingCancellation } from '../shared/file-listing-cancellation'

function createMockProcess(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess
  ;(p as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (p as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(p as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(p as unknown as Record<string, unknown>).kill = vi.fn()
  ;(p as unknown as Record<string, unknown>).exitCode = null
  ;(p as unknown as Record<string, unknown>).signalCode = null
  return p
}

describe('relay list-files cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('listFilesWithRg kills both rg passes and rejects when aborted mid-flight', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    spawnMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('--no-ignore-vcs') ? ignoredProc : primaryProc
    )

    const controller = new AbortController()
    const promise = listFilesWithRg('/remote/root', [], { signal: controller.signal })

    // Partial output before the abort — must be discarded, not resolved.
    ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
    controller.abort()

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(primaryProc.kill).toHaveBeenCalled()
    expect(ignoredProc.kill).toHaveBeenCalled()

    // Late close events after cancellation must not fire anything.
    primaryProc.emit('close', null, 'SIGTERM')
    ignoredProc.emit('close', null, 'SIGTERM')
  })

  it('listFilesWithRg rejects without spawning when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      listFilesWithRg('/remote/root', [], { signal: controller.signal })
    ).rejects.toSatisfy(isFileListingCancellation)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('listFilesWithRg still resolves normally when a signal is provided but never aborted', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    spawnMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('--no-ignore-vcs') ? ignoredProc : primaryProc
    )

    const controller = new AbortController()
    const promise = listFilesWithRg('/remote/root', [], { signal: controller.signal })

    setTimeout(() => {
      ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
      primaryProc.emit('close', 0, null)
      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/out.js\n')
      ignoredProc.emit('close', 0, null)
    }, 5)

    await expect(promise).resolves.toEqual(['src/index.ts', 'dist/out.js'])
  })

  it('listFilesWithGit kills both git passes and rejects when aborted mid-flight', async () => {
    const procs: ChildProcess[] = []
    spawnMock.mockImplementation(() => {
      const proc = createMockProcess()
      procs.push(proc)
      return proc
    })

    const controller = new AbortController()
    const promise = listFilesWithGit('/remote/root', [], { signal: controller.signal })

    expect(procs).toHaveLength(2)
    controller.abort()

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(procs[0].kill).toHaveBeenCalled()
    expect(procs[1].kill).toHaveBeenCalled()
  })

  it('listFilesWithGit rejects without spawning when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      listFilesWithGit('/remote/root', [], { signal: controller.signal })
    ).rejects.toSatisfy(isFileListingCancellation)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
