import { createStandaloneBranchRepo } from './standalone-branch-deletion.test-fixture'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import * as runner from './command-runner/git-exec-file'
import { deleteStandaloneBranch, type StandaloneBranchDeletion } from './standalone-branch-deletion'

let directory: string
let request: StandaloneBranchDeletion

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_COUNT', undefined)
  vi.stubEnv('GIT_CONFIG_PARAMETERS', undefined)
  installRealWorkerThreadChildProcesses()
  ;({ directory, request } = await createStandaloneBranchRepo())
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

async function expectPreserved(input = request): Promise<void> {
  await expect(deleteStandaloneBranch(directory, input)).rejects.toThrow()
  expect(await git('show-ref', '--verify', '--hash', 'refs/heads/feature')).toBe(
    request.expectedOid
  )
}

describe('standalone branch deletion with real Git', () => {
  it('deletes an integrated unattached branch and preserves stashes and working files', async () => {
    await writeFile(join(directory, 'file.txt'), 'stashed\n')
    await git('stash', 'push', '-qm', 'save')
    const stash = await git('rev-parse', 'refs/stash')
    await writeFile(join(directory, 'file.txt'), 'working\n')
    expect(await deleteStandaloneBranch(directory, request)).toEqual({
      deleted: true,
      ref: 'refs/heads/feature',
      oid: request.expectedOid,
      anchorRef: 'refs/remotes/upstream/main',
      anchorOid: request.anchorOid
    })
    const result = await runProcess({
      program: 'git',
      args: ['show-ref', '--verify', '--quiet', 'refs/heads/feature'],
      cwd: directory
    })
    expect(result.code).toBe(1)
    expect(await git('rev-parse', 'refs/stash')).toBe(stash)
    expect(await readFile(join(directory, 'file.txt'), 'utf8')).toBe('working\n')
  })

  it('refuses inherited Git namespace or repository redirection', async () => {
    vi.stubEnv('GIT_NAMESPACE', 'unreviewed')
    await expect(deleteStandaloneBranch(directory, request)).rejects.toThrow()
    vi.unstubAllEnvs()
    expect(await git('rev-parse', 'feature')).toBe(request.expectedOid)
  })

  it('refuses a stale expected OID', async () => {
    await expectPreserved({ ...request, expectedOid: '1111111111111111111111111111111111111111' })
  })

  it('preserves new unpublished commits', async () => {
    await git('checkout', '-q', 'feature')
    await git('commit', '--allow-empty', '-qm', 'unpublished')
    request.expectedOid = await git('rev-parse', 'HEAD')
    await git('checkout', '-q', 'main')
    await expectPreserved()
  })

  it('refuses a branch checked out in a linked worktree', async () => {
    await git('worktree', 'add', '-q', join(directory, 'linked'), 'feature')
    await expectPreserved()
  })

  it('refuses a branch reserved by a detached rebase', async () => {
    await mkdir(join(directory, '.git', 'rebase-merge'))
    await writeFile(join(directory, '.git', 'rebase-merge', 'head-name'), 'refs/heads/feature\n')
    await expectPreserved()
  })

  it.each([
    'refs/heads/main',
    'refs/heads/master',
    'refs/heads/develop',
    'feature',
    'refs/tags/feature',
    'refs/heads/bad..name',
    'refs/heads/MAIN'
  ])('refuses protected or invalid ref %s', async (ref) => {
    await expectPreserved({ ...request, ref })
  })

  it('refuses a configured base branch', async () => {
    await expect(
      deleteStandaloneBranch(directory, request, {}, 'upstream/feature')
    ).rejects.toThrow()
    expect(await git('rev-parse', 'feature')).toBe(request.expectedOid)
  })

  it('refuses missing source remote identity', async () => {
    await git('config', '--unset', 'remote.upstream.url')
    await expectPreserved()
  })

  it('refuses missing default anchor identity', async () => {
    await git('symbolic-ref', '--delete', 'refs/remotes/upstream/HEAD')
    await expectPreserved()
  })

  it('refuses incomplete shallow history', async () => {
    await writeFile(join(directory, '.git', 'shallow'), `${request.expectedOid}\n`)
    await expectPreserved()
  })

  it.each(['branch', 'anchor'])('compares the %s again at deletion', async (which) => {
    await git('commit', '--allow-empty', '-qm', 'new anchor')
    const movedOid = await git('rev-parse', 'HEAD')
    const original = runner.gitExecFileAsync
    vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (args[0] === 'update-ref' && args.includes('--stdin')) {
        await git('update-ref', which === 'branch' ? request.ref : request.anchorRef, movedOid)
      }
      return original(args, options)
    })
    await expect(deleteStandaloneBranch(directory, request)).rejects.toThrow()
    expect(await git('rev-parse', 'feature')).toBe(
      which === 'branch' ? movedOid : request.expectedOid
    )
  })

  it('refuses a branch replaced by a symbolic ref before deletion', async () => {
    const original = runner.gitExecFileAsync
    vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (args[0] === 'update-ref' && args.includes('--stdin')) {
        await git('symbolic-ref', request.ref, 'refs/heads/main')
      }
      return original(args, options)
    })
    await expect(deleteStandaloneBranch(directory, request)).rejects.toThrow()
    expect(await git('symbolic-ref', request.ref)).toBe('refs/heads/main')
    expect(await git('rev-parse', 'main')).toBe(request.anchorOid)
  })

  it('restores the branch when a checkout attaches during deletion', async () => {
    const original = runner.gitExecFileAsync
    vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const result = await original(args, options)
      if (args[0] === 'update-ref' && args.includes('--stdin')) {
        await git('symbolic-ref', 'HEAD', 'refs/heads/feature')
      }
      return result
    })
    await expectPreserved()
    expect(await git('symbolic-ref', 'HEAD')).toBe('refs/heads/feature')
  })

  it('restores the branch when post-delete attachment verification fails', async () => {
    const original = runner.gitExecFileAsync
    let deleted = false
    vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (deleted && args[0] === 'worktree' && args[1] === 'list') {
        throw new Error('Cannot read worktree administration')
      }
      const result = await original(args, options)
      if (args[0] === 'update-ref' && args.includes('--stdin')) {
        deleted = true
      }
      return result
    })
    await expectPreserved()
  })

  it('never overwrites a new branch when attachment-race restoration fails', async () => {
    await git('commit', '--allow-empty', '-qm', 'new work')
    const newOid = await git('rev-parse', 'HEAD')
    const original = runner.gitExecFileAsync
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const result = await original(args, options)
      if (args[0] === 'update-ref' && args.includes('--stdin')) {
        await git('update-ref', request.ref, newOid)
        await git('symbolic-ref', 'HEAD', request.ref)
      }
      return result
    })
    await expect(deleteStandaloneBranch(directory, request)).rejects.toThrow()
    expect(await git('rev-parse', 'feature')).toBe(newOid)
  })

  it('reports failure if an unattached branch reappears before final verification', async () => {
    await git('commit', '--allow-empty', '-qm', 'new work')
    const newOid = await git('rev-parse', 'HEAD')
    const original = runner.gitExecFileAsync
    vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const result = await original(args, options)
      if (args[0] === 'update-ref' && args.includes('--stdin')) {
        await git('update-ref', request.ref, newOid)
      }
      return result
    })
    await expect(deleteStandaloneBranch(directory, request)).rejects.toThrow()
    expect(await git('rev-parse', 'feature')).toBe(newOid)
  })

  it('refuses a second remote whose default branch cannot be verified', async () => {
    await git('remote', 'add', 'unknown', 'https://example.test/other/project.git')
    await expectPreserved()
  })

  it('protects a nonstandard default branch belonging to another remote', async () => {
    await git('remote', 'add', 'other', 'https://example.test/other/project.git')
    await git('update-ref', 'refs/remotes/other/feature', request.expectedOid)
    await git('symbolic-ref', 'refs/remotes/other/HEAD', 'refs/remotes/other/feature')
    await expectPreserved()
  })

  it('preserves the branch if the deletion transaction fails', async () => {
    await writeFile(join(directory, '.git', 'refs', 'heads', 'feature.lock'), '')
    await expectPreserved()
  })
})
