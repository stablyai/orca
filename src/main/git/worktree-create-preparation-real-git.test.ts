import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorktreePreparationLockReason,
  isWorktreeCreatePreparation,
  WORKTREE_CREATE_PREPARATION_DIRECTORY
} from '../../shared/worktree/create-preparation'
import { listWorktrees } from './worktree'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'
import { areWorktreePathsEqual } from './worktree-path-comparison'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

async function createRepo(): Promise<{ repoPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-prepared-worktree-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  git(repoPath, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(repoPath, ['add', 'version.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return { repoPath, root }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('prepared worktree creation with real Git', () => {
  it('cleans up when the create signal is canceled', async () => {
    const { repoPath, root } = await createRepo()
    const preparationRoot = join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY)
    const preparedPath = join(preparationRoot, `${process.pid}-canceled`)
    await mkdir(preparationRoot, { recursive: true })

    await prepareWorktreeCreateCheckout(
      repoPath,
      preparedPath,
      'main',
      createWorktreePreparationLockReason('canceled-test')
    )

    const controller = new AbortController()
    controller.abort()
    await expect(
      discardPreparedWorktree(repoPath, preparedPath, { signal: controller.signal })
    ).resolves.toBeUndefined()

    expect(await listWorktrees(repoPath, { includeCreatePreparations: true })).toHaveLength(1)
  })

  it('hides the preparation, retargets an advanced base, and attaches the final branch', async () => {
    const { repoPath, root } = await createRepo()
    const preparationRoot = join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY)
    const preparedPath = join(preparationRoot, `${process.pid}-test`)
    const finalPath = join(root, 'final-worktree')
    await mkdir(preparationRoot, { recursive: true })

    await prepareWorktreeCreateCheckout(
      repoPath,
      preparedPath,
      'main',
      createWorktreePreparationLockReason('real-git-test')
    )

    const visibleBeforeSubmit = await listWorktrees(repoPath)
    const allBeforeSubmit = await listWorktrees(repoPath, { includeCreatePreparations: true })
    expect(visibleBeforeSubmit).toHaveLength(1)
    expect(allBeforeSubmit).toHaveLength(2)
    expect(allBeforeSubmit.find(isWorktreeCreatePreparation)).toMatchObject({
      locked: true,
      lockReason: expect.stringContaining('orca-create-preparation:v1:')
    })

    await writeFile(join(repoPath, 'version.txt'), 'two\n')
    git(repoPath, ['add', 'version.txt'])
    git(repoPath, ['commit', '--quiet', '-m', 'advance base'])
    const latestHead = git(repoPath, ['rev-parse', 'HEAD'])

    await finalizePreparedWorktree(
      repoPath,
      preparedPath,
      finalPath,
      'feature/prepared',
      'main',
      false
    )

    expect(git(finalPath, ['rev-parse', 'HEAD'])).toBe(latestHead)
    expect(git(finalPath, ['branch', '--show-current'])).toBe('feature/prepared')
    expect((await readFile(join(finalPath, 'version.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe(
      'two\n'
    )
    expect(git(finalPath, ['config', '--get', 'branch.feature/prepared.base'])).toBe(
      'refs/heads/main'
    )
    expect(git(finalPath, ['config', '--get', 'push.autoSetupRemote'])).toBe('true')
    const listedWorktrees = await listWorktrees(repoPath)
    const resolvedFinalPath = await realpath(finalPath)
    expect(
      listedWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, resolvedFinalPath))
    ).toBe(true)
    expect(
      listedWorktrees.find((worktree) => areWorktreePathsEqual(worktree.path, resolvedFinalPath))
        ?.locked
    ).not.toBe(true)
  })
})
