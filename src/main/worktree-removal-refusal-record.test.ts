import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeWorktree } from './git/worktree-removal'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval
} from './worktree-background-removal'
import { isCheckoutRegistered } from './worktree-removal-leftover'
import { readWorktreeRemovalState } from './worktree-removal-state'

vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))

const execFileAsync = promisify(execFile)

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function commitRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(['init', '-q'], path)
  await git(['config', 'user.email', 'removal@example.invalid'], path)
  await git(['config', 'user.name', 'Worktree Removal'], path)
  await writeFile(join(path, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], path)
  await git(['commit', '-qm', 'seed'], path)
}

// Why real Git: the refusal under test is Git's own, and it keeps the checkout registered.
describe('a delete Git refuses while keeping the checkout registered', () => {
  let repoPath = ''
  let worktreePath = ''

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'orca-refused-removal-')))
    repoPath = join(scratch, 'repo')
    worktreePath = join(scratch, 'workspaces', 'feature')
    const submoduleSource = join(scratch, 'submodule-source')
    await commitRepo(repoPath)
    await commitRepo(submoduleSource)
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
    await git(
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleSource, 'sub'],
      worktreePath
    )
    await git(['commit', '-qm', 'add submodule'], worktreePath)
  })

  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
  })

  it("reports Git's reason to a caller polling the outcome", async () => {
    const worktreeId = `repo-1::${worktreePath}`
    const refused = await startBackgroundWorktreeRemoval({
      removal: {
        worktreeId,
        repoId: 'repo-1',
        repoPath,
        worktree: { path: worktreePath, branch: 'refs/heads/feature', head: 'abc' },
        deleteBranch: true,
        force: false
      },
      run: () => removeWorktree(repoPath, worktreePath, false),
      publish: () => {}
    }).then(
      () => undefined,
      (reason: unknown) => reason
    )
    await _settlePendingWorktreeRemovalsForTests()

    expect(String(refused)).toMatch(/submodules/)
    expect(await isCheckoutRegistered({ repoPath, worktreePath })).toBe(true)
    expect(
      await readWorktreeRemovalState(worktreeId, 'local', {
        isListed: async () => true,
        preservedBranch: () => undefined
      })
    ).toEqual({ state: 'failed', message: expect.stringMatching(/submodules/) })
  })
})
