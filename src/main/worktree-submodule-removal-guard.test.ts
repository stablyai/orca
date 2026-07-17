import { describe, expect, it, vi } from 'vitest'
import {
  assertSubmoduleWorktreeSafeToForceRemove,
  sshSubmoduleRemovalGuardGitExec,
  SUBMODULE_REMOVAL_GUARD_TIMEOUT_MS
} from './worktree-submodule-removal-guard'
import { UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE } from '../shared/worktree-removal'

const originalError = Object.assign(new Error('Command failed: git worktree remove'), {
  stderr: 'fatal: working trees containing submodules cannot be moved or removed'
})

function guardExec(statusStdout: string, foreachStdout: string, submoduleStatusStdout = '') {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'status') {
      return { stdout: statusStdout }
    }
    if (args[0] === 'submodule' && args[1] === 'status') {
      return { stdout: submoduleStatusStdout }
    }
    return { stdout: foreachStdout }
  })
}

describe('assertSubmoduleWorktreeSafeToForceRemove', () => {
  it('passes for a clean tree whose submodule commits all exist on a remote', async () => {
    const exec = guardExec('', '0\n0\n', ' f00bbe3 vendor/sub (heads/main)\n')
    await expect(
      assertSubmoduleWorktreeSafeToForceRemove(exec, originalError, '/workspaces/feature')
    ).resolves.toBeUndefined()
    // Why --ignore-submodules=none: plain status honors diff.ignoreSubmodules /
    // submodule.<name>.ignore config that can hide a dirty submodule.
    expect(exec).toHaveBeenCalledWith([
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignore-submodules=none'
    ])
    expect(exec).toHaveBeenCalledWith(['submodule', 'status', '--recursive'])
    expect(exec).toHaveBeenCalledWith([
      'submodule',
      'foreach',
      '--recursive',
      '--quiet',
      'git rev-list --count HEAD --not --remotes'
    ])
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('throws the classified dirty error when strict status reports changes', async () => {
    await expect(
      assertSubmoduleWorktreeSafeToForceRemove(
        guardExec(' M vendor/sub\n', '0\n'),
        originalError,
        '/workspaces/feature'
      )
    ).rejects.toThrow('Worktree has uncommitted or untracked changes.')
  })

  it('throws the unpushed-submodules error when a submodule has local-only commits', async () => {
    await expect(
      assertSubmoduleWorktreeSafeToForceRemove(
        guardExec('', '0\n2\n'),
        originalError,
        '/workspaces/feature'
      )
    ).rejects.toThrow(UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE)
  })

  it('throws the unpushed-submodules error for a deinit-leftover or inactive submodule', async () => {
    // Why: `git submodule deinit` keeps the submodule database under the
    // worktree admin dir where `submodule foreach` cannot see it; a dash
    // entry means the state cannot be verified, so force must be explicit.
    await expect(
      assertSubmoduleWorktreeSafeToForceRemove(
        guardExec('', '', '-f00bbe3 vendor/sub\n'),
        originalError,
        '/workspaces/feature'
      )
    ).rejects.toThrow(UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE)
  })

  it('throws the unpushed-submodules error when git found an unlisted leftover database', async () => {
    // Why: the preceding removal refusal proves submodule admin state exists;
    // empty porcelain means .gitmodules no longer names it for inspection.
    await expect(
      assertSubmoduleWorktreeSafeToForceRemove(
        guardExec('', '', ''),
        originalError,
        '/workspaces/feature'
      )
    ).rejects.toThrow(UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE)
  })

  it('surfaces the original refusal when the tree cannot be verified', async () => {
    const exec = vi.fn(async () => {
      throw new Error('fatal: not a git repository')
    })
    await expect(
      assertSubmoduleWorktreeSafeToForceRemove(exec, originalError, '/workspaces/feature')
    ).rejects.toThrow('Failed to delete worktree at /workspaces/feature.')
  })
})

describe('sshSubmoduleRemovalGuardGitExec', () => {
  it('resolves stdout for a zero exit', async () => {
    const provider = {
      execNonInteractive: vi
        .fn()
        .mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0, timedOut: false })
    }
    const exec = sshSubmoduleRemovalGuardGitExec(provider, '/remote/feature-wt')
    await expect(exec(['status', '--porcelain'])).resolves.toEqual({ stdout: 'out' })
    expect(provider.execNonInteractive).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      '/remote/feature-wt',
      SUBMODULE_REMOVAL_GUARD_TIMEOUT_MS
    )
  })

  it.each([
    ['non-zero exit', { stdout: '', stderr: '', exitCode: 128, timedOut: false }],
    ['timeout', { stdout: '', stderr: '', exitCode: null, timedOut: true }],
    ['spawn error', { stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: 'nope' }]
  ])('rejects on %s so the guard fails closed', async (_label, result) => {
    const provider = { execNonInteractive: vi.fn().mockResolvedValue(result) }
    const exec = sshSubmoduleRemovalGuardGitExec(provider, '/remote/feature-wt')
    await expect(exec(['status'])).rejects.toThrow()
  })
})
