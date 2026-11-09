import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getSetupEnvVars } from './setup-hook-env-vars'

const folder: Repo = {
  id: 'repo',
  path: '/code/acme',
  displayName: 'acme',
  badgeColor: '',
  addedAt: 0,
  kind: 'folder'
}

describe('getSetupEnvVars', () => {
  it('names a folder workspace by its own name and id, which `orca worktree create` reads', () => {
    const env = getSetupEnvVars(folder, '/code/acme', {
      worktreeId: 'repo::/code/acme::workspace:1',
      displayName: 'Fix login'
    })
    expect(env).toMatchObject({
      ORCA_WORKSPACE_NAME: 'Fix login',
      ORCA_WORKTREE_ID: 'repo::/code/acme::workspace:1',
      ORCA_WORKSPACE_ID: 'repo::/code/acme::workspace:1',
      ORCA_ROOT_PATH: '/code/acme',
      CONDUCTOR_WORKSPACE_NAME: 'Fix login'
    })
  })

  it('sets the workspace variables imported Conductor scripts read', () => {
    const repo: Pick<Repo, 'path'> = { path: '/repos/acme' }
    const env = getSetupEnvVars(repo, '/worktrees/acme/fix-login')
    expect(env).toMatchObject({
      CONDUCTOR_ROOT_PATH: '/repos/acme',
      CONDUCTOR_WORKSPACE_PATH: '/worktrees/acme/fix-login',
      CONDUCTOR_WORKSPACE_NAME: 'fix-login'
    })
  })
})
