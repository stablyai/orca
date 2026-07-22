import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import { addWorktreeOp } from './git-handler-worktree-ops'

const worktreeParams = {
  repoPath: '/repo',
  branchName: 'feature/test',
  targetDir: '/repo-feature'
}

function abortError(controller: AbortController, message: string): Error {
  controller.abort()
  return Object.assign(new Error(message), { name: 'AbortError' })
}

describe('addWorktreeOp cancellation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stops base-ref fallback when the request is cancelled', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async () => {
      throw abortError(controller, 'base probe cancelled')
    })

    await expect(
      addWorktreeOp(
        git,
        { ...worktreeParams, base: 'origin/main' },
        {
          signal: controller.signal
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError', message: 'base probe cancelled' })

    expect(git).toHaveBeenCalledTimes(1)
  })

  it('does not clean up base metadata after a cancelled persistence write', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'config' && args[2] === '--replace-all') {
        throw abortError(controller, 'base persistence cancelled')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(
        git,
        { ...worktreeParams, base: 'origin/main' },
        {
          signal: controller.signal
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError', message: 'base persistence cancelled' })

    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual([
      'config',
      '--local',
      '--unset-all',
      'branch.feature/test.base'
    ])
  })

  it('rethrows cancellation while clearing stale base metadata', async () => {
    const controller = new AbortController()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'config' && args[2] === '--replace-all') {
        throw new Error('config locked')
      }
      if (args[0] === 'config' && args[2] === '--unset-all') {
        throw abortError(controller, 'base cleanup cancelled')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(
        git,
        { ...worktreeParams, base: 'origin/main' },
        {
          signal: controller.signal
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError', message: 'base cleanup cancelled' })

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('rethrows cancellation while reading push.autoSetupRemote', async () => {
    const controller = new AbortController()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'config' && args[1] === '--get') {
        throw abortError(controller, 'config read cancelled')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(git, worktreeParams, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError', message: 'config read cancelled' })

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('rethrows cancellation while writing push.autoSetupRemote', async () => {
    const controller = new AbortController()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'config' && args[1] === '--get') {
        throw Object.assign(new Error('key unset'), { code: 1 })
      }
      if (args[0] === 'config' && args[2] === 'push.autoSetupRemote') {
        throw abortError(controller, 'config write cancelled')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(git, worktreeParams, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError', message: 'config write cancelled' })

    expect(warnSpy).not.toHaveBeenCalled()
  })
})
