import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getSetupEnvVars } from './setup-hook-env-vars'

describe('getSetupEnvVars', () => {
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
