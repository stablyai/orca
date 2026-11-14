import { mocks, repo, store } from '../../../__mocks__/worktree-create-preparation'
import { describe, expect, it } from 'vitest'

import '../../../../shared/worktree/creation/create-preparation'
import {
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

describe('worktree create preparation registry', () => {
  it('does not claim a preparation after the selected base changes to another branch', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/release'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'base_mismatch' })
  })

  it('refuses a same-family retarget whose bases have drifted too far apart', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    // An abandoned fork's `main` is the same base family but a whole-tree checkout away.
    mocks.measureDivergence.mockResolvedValue('exceeded')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'main'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'retarget_too_divergent' })
  })

  it('separates a drift check that said no from one that could not answer', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    // Unverifiable drift must not be reported as measured excess divergence.
    mocks.measureDivergence.mockResolvedValue('unknown')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'main'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'retarget_unverifiable' })
  })

  it('reports which part of the claim key disagreed', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/other-workspace',
        worktreePath: '/other-workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'workspace_root_mismatch' })

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main',
        options: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toEqual({ status: 'miss', reason: 'wsl_distro_mismatch' })

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: '/other-repo',
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'repo_mismatch' })
  })
})
