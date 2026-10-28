import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseWorktreeList } from '../../../shared/git-worktree-porcelain-parser'
import type { ConditionalWorktreeRemovalRequest } from '../../../shared/rpc-contract/conditional-worktree-removal'
import { beginTerminalInstall } from '../../ipc/watcher-removal-gate'
import { beginConditionalWorktreeUse } from '../../ipc/conditional-worktree-removal-lease'
import {
  removeConditionalWorktree,
  type ConditionalWorktreeRemovalDependencies
} from './conditional-worktree-removal'
import { physicalIdentity } from './conditional-worktree-removal-git'

const execute = promisify(execFile)
async function git(cwd: string, ...args: string[]) {
  return (await execute('git', args, { cwd })).stdout.trim()
}

// Keep the real Git/filesystem boundary without loading Electron's process and observability services.
vi.mock('../../git/runner', () => ({
  gitExecFileAsync: async (args: string[], options: { cwd: string }) =>
    execute('git', args, options)
}))
vi.mock('../../git/worktree', async () => {
  const { assertWorktreeCleanForRemoval } = await import('../../git/worktree-removal-preflight')
  return {
    assertWorktreeCleanForRemoval,
    listWorktreesStrict: async (path: string) =>
      parseWorktreeList(await git(path, 'worktree', 'list', '--porcelain')),
    removeWorktree: vi.fn(
      async (
        repo: string,
        path: string,
        force: boolean,
        options: { deleteBranch: boolean; refuseFilesystemFallback: boolean }
      ) => {
        expect(force).toBe(false)
        expect(options.deleteBranch).toBe(false)
        expect(options.refuseFilesystemFallback).toBe(true)
        await git(repo, 'worktree', 'remove', path)
        return {}
      }
    )
  }
})

let scratch: string,
  repo: string,
  checkout: string,
  request: ConditionalWorktreeRemovalRequest,
  deps: ConditionalWorktreeRemovalDependencies,
  occupant: 'same' | 'absent' | 'changed'
beforeEach(async () => {
  occupant = 'same'
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'orca-idle-removal-')))
  repo = join(scratch, 'repo')
  checkout = join(scratch, 'checkout')
  await mkdir(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.name', 'Removal fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'tracked'), 'initial\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'seed')
  await git(repo, 'worktree', 'add', '-qb', 'fixture-branch', checkout)
  const head = await git(checkout, 'rev-parse', 'HEAD')
  await git(repo, 'update-ref', 'refs/remotes/fixture/fixture-branch', head)
  await git(repo, 'config', 'branch.fixture-branch.remote', 'fixture')
  await git(repo, 'config', 'remote.fixture.fetch', '+refs/heads/*:refs/remotes/fixture/*')
  await git(repo, 'config', 'branch.fixture-branch.merge', 'refs/heads/fixture-branch')
  request = {
    requestId: randomUUID(),
    expected: {
      worktreeId: `repo::${checkout}`,
      identityKey: 'wt2:local:fixture',
      instanceId: 'fixture',
      executionHostId: 'local',
      repoId: 'repo',
      branch: 'refs/heads/fixture-branch',
      head,
      checkout: await physicalIdentity(checkout),
      commonGitDirectory: await physicalIdentity(
        resolve(checkout, await git(checkout, 'rev-parse', '--git-common-dir'))
      ),
      adminDirectory: await physicalIdentity(
        resolve(checkout, await git(checkout, 'rev-parse', '--git-dir'))
      )
    }
  }
  deps = {
    repoPath: repo,
    profileDirectory: join(scratch, 'profile'),
    supported: true,
    verifyOccupant: async () => occupant,
    verifyIdle: async () => 'idle',
    finishMetadata: vi.fn(async () => {
      occupant = 'absent'
    })
  }
})
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('conditional removal transaction with real Git fixtures', () => {
  it.each(['checkout', 'registration', 'occupant', 'branch', 'retained-ref'] as const)(
    'keeps the prepared receipt when first-success readback finds changed %s',
    async (changed) => {
      deps.finishMetadata = async () => {
        if (changed === 'checkout') {
          await mkdir(checkout)
        }
        if (changed === 'registration') {
          await git(repo, 'worktree', 'add', '--detach', checkout, request.expected.head)
          await rm(checkout, { recursive: true, force: true })
        }
        if (changed === 'occupant') {
          deps.verifyOccupant = async () => 'changed'
        }
        if (changed === 'branch') {
          await git(repo, 'update-ref', '-d', request.expected.branch)
        }
        if (changed === 'retained-ref') {
          await git(repo, 'update-ref', '-d', `refs/orca-retained-worktrees/${request.requestId}`)
        }
      }
      await expect(removeConditionalWorktree(request, deps)).resolves.toMatchObject({
        status: 'refused',
        reason: 'outcome_unknown'
      })
      const receipt = JSON.parse(
        await readFile(
          join(deps.profileDirectory, 'conditional-worktree-removals', `${request.requestId}.json`),
          'utf8'
        )
      )
      expect(receipt.phase).toBe('prepared')
      await expect(removeConditionalWorktree(request, deps)).resolves.toMatchObject({
        status: 'refused',
        reason: changed === 'occupant' ? 'identity_changed' : 'outcome_unknown'
      })
    }
  )

  it('removes only a proven idle checkout, preserves branch and retained commit, and replays readback', async () => {
    const result = await removeConditionalWorktree(request, deps)
    expect(result.status).toBe('removed')
    await expect(access(checkout)).rejects.toThrow()
    expect(await git(repo, 'rev-parse', request.expected.branch)).toBe(request.expected.head)
    expect(await git(repo, 'rev-parse', `refs/orca-retained-worktrees/${request.requestId}`)).toBe(
      request.expected.head
    )
    expect(await removeConditionalWorktree(request, deps)).toEqual(result)
    expect(deps.finishMetadata).toHaveBeenCalledTimes(1)
  })

  it('retries metadata cleanup when removal stopped after preparing its receipt', async () => {
    let attempts = 0
    deps.finishMetadata = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('simulated interruption')
      }
      occupant = 'absent'
    })

    await expect(removeConditionalWorktree(request, deps)).resolves.toMatchObject({
      status: 'refused',
      reason: 'outcome_unknown'
    })
    await expect(access(checkout)).rejects.toThrow()

    await expect(removeConditionalWorktree(request, deps)).resolves.toMatchObject({
      status: 'removed'
    })
    expect(deps.finishMetadata).toHaveBeenCalledTimes(2)
    await expect(removeConditionalWorktree(request, deps)).resolves.toMatchObject({
      status: 'removed'
    })
    expect(deps.finishMetadata).toHaveBeenCalledTimes(2)
  })

  it.each(['live', 'unknown'] as const)(
    'refuses %s sessions without creating retention state',
    async (state) => {
      deps.verifyIdle = async () => state
      expect((await removeConditionalWorktree(request, deps)).status).toBe('refused')
      await access(checkout)
      await expect(access(deps.profileDirectory)).rejects.toThrow()
      expect(deps.finishMetadata).not.toHaveBeenCalled()
    }
  )

  it('refuses a prior terminal start rather than cancelling it', async () => {
    const release = beginTerminalInstall(checkout)
    try {
      expect(await removeConditionalWorktree(request, deps)).toMatchObject({
        status: 'refused',
        reason: 'busy'
      })
    } finally {
      release()
    }
    await access(checkout)
  })

  it('rejects terminal and structured/layout use racing after lease acquisition', async () => {
    deps.verifyIdle = async () => {
      expect(() => beginTerminalInstall(checkout)).toThrow('removal is in progress')
      expect(() => beginConditionalWorktreeUse(request.expected.worktreeId)).toThrow(
        'removal is in progress'
      )
      await Promise.resolve()
      return 'idle'
    }
    expect((await removeConditionalWorktree(request, deps)).status).toBe('removed')
  })

  it('preserves ignored files and refuses before any retained ref or receipt is created', async () => {
    await writeFile(join(checkout, '.gitignore'), 'private.env\n')
    await writeFile(join(checkout, 'private.env'), 'fixture-only\n')
    expect((await removeConditionalWorktree(request, deps)).status).toBe('refused')
    await access(join(checkout, 'private.env'))
    await expect(access(deps.profileDirectory)).rejects.toThrow()
  })

  it('does not remove a same-path replacement after a lost completion', async () => {
    deps.finishMetadata = async () => {
      throw new Error('fixture lost reply')
    }
    expect(await removeConditionalWorktree(request, deps)).toMatchObject({
      status: 'refused',
      reason: 'outcome_unknown'
    })
    await mkdir(checkout)
    await writeFile(join(checkout, 'new-owner'), 'keep\n')
    deps.verifyOccupant = async () => 'changed'
    expect((await removeConditionalWorktree(request, deps)).status).toBe('refused')
    await access(join(checkout, 'new-owner'))
  })

  it('refuses stale physical identity and unsupported hosts before changing files', async () => {
    request.expected.checkout.inode = '0'
    expect(await removeConditionalWorktree(request, deps)).toMatchObject({
      status: 'refused',
      reason: 'identity_changed'
    })
    deps.supported = false
    expect(await removeConditionalWorktree(request, deps)).toMatchObject({
      status: 'refused',
      reason: 'unsupported'
    })
    await access(checkout)
  })
})
