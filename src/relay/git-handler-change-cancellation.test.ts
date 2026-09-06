/**
 * Relay staging/commit cancellation: a canceled request must abandon the
 * worktree mutation lane and the index-lock retry backoff instead of mutating
 * the remote worktree once it finally gets a turn.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import { writeFileSync } from 'node:fs'
import type { GitHandler } from './git-handler'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir,
  type GitSpyTarget
} from './git-handler-test-harness'

async function waitForCalls(mock: { mock: { calls: unknown[] } }, calls: number): Promise<void> {
  for (let i = 0; i < 50 && mock.mock.calls.length < calls; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

function indexLockError(): Error {
  const error = new Error('cannot lock ref') as Error & { stderr: string }
  error.stderr = "fatal: Unable to create '.git/index.lock': File exists."
  return error
}

describe('GitHandler — canceled worktree mutations', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createGitTempDir()
    gitInit(tmpDir)
    writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
    gitCommit(tmpDir, 'initial')
    writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await removeGitTempDir(tmpDir)
  })

  it('does not run a queued stage whose request was canceled', async () => {
    let releaseFirst!: () => void
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const gitSpy = vi
      .spyOn(handler as unknown as GitSpyTarget, 'git')
      .mockImplementationOnce(async () => {
        await firstRunning
        return { stdout: '', stderr: '' }
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    const first = dispatcher.callRequest('git.stage', {
      worktreePath: tmpDir,
      filePath: 'file.txt'
    })
    await waitForCalls(gitSpy, 1)

    const controller = new AbortController()
    const queued = dispatcher.callRequest(
      'git.stage',
      { worktreePath: tmpDir, filePath: 'file.txt' },
      { isStale: () => controller.signal.aborted, signal: controller.signal }
    )
    controller.abort()

    await expect(queued).rejects.toThrow(/abort/i)
    releaseFirst()
    await first
    expect(gitSpy).toHaveBeenCalledTimes(1)
  })

  it('stops the index-lock retry backoff for a canceled bulk stage', async () => {
    const gitSpy = vi
      .spyOn(handler as unknown as GitSpyTarget, 'git')
      .mockImplementation(async () => {
        throw indexLockError()
      })

    const controller = new AbortController()
    const pending = dispatcher.callRequest(
      'git.bulkStage',
      { worktreePath: tmpDir, filePaths: ['file.txt'] },
      { isStale: () => controller.signal.aborted, signal: controller.signal }
    )
    await waitForCalls(gitSpy, 1)
    controller.abort()

    await expect(pending).rejects.toThrow(/abort/i)
    expect(gitSpy).toHaveBeenCalledTimes(1)
  })

  it('lets an in-flight commit finish when the request is canceled', async () => {
    let releaseCommit!: () => void
    const commitRunning = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const gitSpy = vi
      .spyOn(handler as unknown as GitSpyTarget, 'git')
      .mockImplementation(async (_args, _cwd, opts) => {
        // Why: a started commit must not be killed by a client timeout or disconnect.
        expect(opts?.signal).toBeUndefined()
        await commitRunning
        return { stdout: '', stderr: '' }
      })

    const controller = new AbortController()
    const pending = dispatcher.callRequest(
      'git.commit',
      { worktreePath: tmpDir, message: 'in-flight commit' },
      { isStale: () => controller.signal.aborted, signal: controller.signal }
    )
    await waitForCalls(gitSpy, 1)
    controller.abort()
    releaseCommit()

    await expect(pending).resolves.toEqual({ success: true })
    expect(gitSpy).toHaveBeenCalledTimes(1)
  })

  it('does not run a queued commit whose request was canceled', async () => {
    let releaseFirst!: () => void
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const gitSpy = vi
      .spyOn(handler as unknown as GitSpyTarget, 'git')
      .mockImplementationOnce(async () => {
        await firstRunning
        return { stdout: '', stderr: '' }
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    const first = dispatcher.callRequest('git.stage', {
      worktreePath: tmpDir,
      filePath: 'file.txt'
    })
    await waitForCalls(gitSpy, 1)

    const controller = new AbortController()
    const queued = dispatcher.callRequest(
      'git.commit',
      { worktreePath: tmpDir, message: 'canceled commit' },
      { isStale: () => controller.signal.aborted, signal: controller.signal }
    )
    controller.abort()

    await expect(queued).rejects.toThrow(/abort/i)
    releaseFirst()
    await first
    expect(gitSpy).toHaveBeenCalledTimes(1)
  })
})
