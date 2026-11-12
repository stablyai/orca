import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import type { AddWorktreeOptions } from '../../../git/worktrees/worktree-operation-options'
import { createRuntimeLocalGitWorktree } from '../../../runtime/workspaces/creation/runtime-local-git-worktree-create'
import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { startPreparation } from './worktree-create-preparation-pool'

const roots: string[] = []
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-preparation-lifetime-')))
  roots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(repoPath, 'config', 'user.email', 'test@example.com')
  git(repoPath, 'config', 'user.name', 'Test User')
  git(repoPath, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repoPath, 'version.txt'), 'original\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '--quiet', '-m', 'initial')
  const repo = {
    id: 'lifetime-repo',
    path: repoPath,
    displayName: 'Repo',
    addedAt: 0,
    badgeColor: ''
  }
  const arm = (
    beforeMaterialization?: Promise<void>,
    options: AddWorktreeOptions = {},
    baseBranch = 'main'
  ) =>
    startPreparation({
      repoPath,
      workspaceRoot: root,
      baseBranch,
      canonicalBase: baseBranch === 'origin/main' ? 'refs/remotes/origin/main' : 'refs/heads/main',
      options,
      beforeMaterialization
    })
  const create = async (
    branch: string,
    baseBranch = 'main',
    options: AddWorktreeOptions = {},
    waiting?: () => void,
    timing = createWorktreeCreateTimingRecorder()
  ) => {
    const time = timing.time.bind(timing)
    timing.time = (phase, operation) => {
      if (phase === 'prepared_checkout_wait') {
        waiting?.()
      }
      return time(phase, operation)
    }
    const rearm = { fire: () => {} }
    try {
      return await createRuntimeLocalGitWorktree({
        request: { repoSelector: repo.id, name: branch },
        repo,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no metadata/push/name-retirement operation is requested at this Git-only host boundary.
        store: {} as RuntimeStore,
        settings: {
          workspaceDir: root,
          nestWorkspaces: false,
          refreshLocalBaseRefOnWorktreeCreate: false
        },
        base: { baseBranch, remoteTrackingBase: null, deferredRefresh: null },
        workspaceRoot: root,
        branchName: branch,
        worktreePath: join(root, branch),
        checkoutExistingBranch: false,
        localWorktreeGitOptions: options,
        // Foreground freshness already completed; the obsolete speculative barrier is independent.
        baseRefRefresh: { finish: async () => {} },
        rearm,
        timing
      })
    } finally {
      timing.finish()
      rearm.fire()
    }
  }
  return { root, repoPath, arm, create }
}

export async function removeLifetimeFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}
