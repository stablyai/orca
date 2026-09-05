import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createWorktreePreparationLockReason } from '../../shared/worktree/create-preparation'
import { gitExecFileAsync } from './runner'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'

// Opt in on Windows with a running distro; all Git commands use the production WSL router.
const wslDistro = process.env.ORCA_TEST_WSL_DISTRO

it.skipIf(process.platform !== 'win32' || !wslDistro)(
  'prepares, retargets, moves and cleans up a real WSL checkout from Windows',
  async () => {
    const fixtureParent = process.env.ORCA_TEST_WSL_ROOT ?? `\\\\wsl.localhost\\${wslDistro}\\tmp`
    const root = await mkdtemp(join(fixtureParent, 'orca-create-route-'))
    const repoPath = join(root, 'repo')
    const preparedPath = join(root, 'prepared checkout')
    const finalPath = join(root, 'final checkout')
    const options = { wslDistro, timeout: 60_000 }
    const git = async (cwd: string, args: string[]): Promise<string> =>
      (await gitExecFileAsync(args, { cwd, ...options })).stdout.trim()

    try {
      await mkdir(repoPath)
      await git(repoPath, ['init', '--quiet'])
      expect(await git(repoPath, ['rev-parse', '--show-toplevel'])).toMatch(/^\/(?!\/)/)
      await git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
      await git(repoPath, ['config', 'user.name', 'Test User'])
      await git(repoPath, ['config', 'user.email', 'test@example.com'])
      await writeFile(join(repoPath, 'version.txt'), 'one\n')
      await git(repoPath, ['add', 'version.txt'])
      await git(repoPath, ['commit', '--quiet', '-m', 'initial'])
      await prepareWorktreeCreateCheckout(
        repoPath,
        preparedPath,
        'main',
        createWorktreePreparationLockReason('real-wsl-test'),
        options
      )
      expect(await git(repoPath, ['worktree', 'list', '--porcelain'])).toContain(
        'locked orca-create-preparation:v1:'
      )

      await writeFile(join(repoPath, 'version.txt'), 'two\n')
      await git(repoPath, ['commit', '--quiet', '-am', 'advance base'])
      const target = await git(repoPath, ['rev-parse', 'HEAD'])
      await finalizePreparedWorktree(
        repoPath,
        preparedPath,
        finalPath,
        'feature/routed',
        'main',
        false,
        options
      )
      expect(await git(finalPath, ['rev-parse', 'HEAD'])).toBe(target)
      expect(await git(finalPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature/routed')
      expect(await git(finalPath, ['status', '--porcelain'])).toBe('')
      expect(await readFile(join(finalPath, 'version.txt'), 'utf8')).toBe('two\n')
      expect(await git(finalPath, ['config', '--get', 'branch.feature/routed.base'])).toBe(
        'refs/heads/main'
      )
      expect(await git(repoPath, ['worktree', 'list', '--porcelain'])).not.toContain('locked ')
      await discardPreparedWorktree(repoPath, finalPath, options)
      expect(
        (await git(repoPath, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)
      ).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)
