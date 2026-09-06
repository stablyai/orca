import { execFileSync } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as gitRunner from './runner'
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
  it('removes partial checkout files and registration after materialization is aborted', async () => {
    const { repoPath, root } = await createRepo()
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        writeFile(
          join(repoPath, `payload-${index.toString().padStart(4, '0')}.txt`),
          'payload'.repeat(128)
        )
      )
    )
    git(repoPath, ['add', '.'])
    git(repoPath, ['commit', '--quiet', '-m', 'materialization fixture'])
    const preparationRoot = join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY)
    const preparedPath = join(preparationRoot, `${process.pid}-partial`)
    await mkdir(preparationRoot, { recursive: true })
    const controller = new AbortController()
    const original = gitRunner.gitExecFileAsync
    let watcher: FSWatcher | undefined
    let observedMaterialization = false
    const calls: string[][] = []
    const spy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation((args, options) => {
      calls.push([...args])
      if (args.includes('reset')) {
        watcher = watch(preparedPath, (_event, filename) => {
          // Only the reset writes here, so an event without a filename is still materialization.
          if (filename === null || filename.toString().startsWith('payload-')) {
            observedMaterialization = true
            watcher?.close()
            controller.abort()
          }
        })
      }
      return original(args, options)
    })
    try {
      await expect(
        prepareWorktreeCreateCheckout(
          repoPath,
          preparedPath,
          'main',
          createWorktreePreparationLockReason('partial-test'),
          { signal: controller.signal }
        )
      ).rejects.toThrow()
      expect(observedMaterialization).toBe(true)
      expect(calls.some((args) => args[args.indexOf('worktree') + 1] === 'lock')).toBe(false)
      expect(existsSync(preparedPath)).toBe(false)
      expect(await listWorktrees(repoPath, { includeCreatePreparations: true })).toHaveLength(1)
    } finally {
      watcher?.close()
      spy.mockRestore()
    }
  })

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

  it('lands a cross-base retarget on exactly the requested commit', async () => {
    const { repoPath, root } = await createRepo()
    const preparationRoot = join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY)
    const preparedPath = join(preparationRoot, `${process.pid}-retarget`)
    const finalPath = join(root, 'retargeted-worktree')
    await mkdir(preparationRoot, { recursive: true })

    await writeFile(join(repoPath, 'shared.txt'), 'kept\n')
    git(repoPath, ['add', 'shared.txt'])
    git(repoPath, ['commit', '--quiet', '-m', 'local main'])
    const localMainHead = git(repoPath, ['rev-parse', 'HEAD'])

    // A remote-tracking `main` that diverged: different content, an extra file, and one deletion.
    git(repoPath, ['checkout', '--quiet', '-b', 'upstream-main'])
    await writeFile(join(repoPath, 'version.txt'), 'two\n')
    await writeFile(join(repoPath, 'only-upstream.txt'), 'upstream\n')
    git(repoPath, ['rm', '--quiet', 'shared.txt'])
    git(repoPath, ['add', 'version.txt', 'only-upstream.txt'])
    git(repoPath, ['commit', '--quiet', '-m', 'upstream main'])
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(repoPath, ['checkout', '--quiet', 'main'])
    git(repoPath, ['branch', '--quiet', '-D', 'upstream-main'])

    await prepareWorktreeCreateCheckout(
      repoPath,
      preparedPath,
      'refs/remotes/origin/main',
      createWorktreePreparationLockReason('retarget-test')
    )
    expect(git(preparedPath, ['rev-parse', 'HEAD'])).not.toBe(localMainHead)

    await finalizePreparedWorktree(repoPath, preparedPath, finalPath, 'feature/retargeted', 'main')

    expect(git(finalPath, ['rev-parse', 'HEAD'])).toBe(localMainHead)
    // A retarget that left stale files behind would be a wrong checkout, not just a slow one.
    expect(git(finalPath, ['status', '--porcelain'])).toBe('')
    expect((await readFile(join(finalPath, 'version.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe(
      'one\n'
    )
    expect((await readFile(join(finalPath, 'shared.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe(
      'kept\n'
    )
    await expect(readFile(join(finalPath, 'only-upstream.txt'), 'utf8')).rejects.toThrow()
    expect(git(finalPath, ['branch', '--show-current'])).toBe('feature/retargeted')
    expect(git(finalPath, ['config', '--get', 'branch.feature/retargeted.base'])).toBe(
      'refs/heads/main'
    )
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
