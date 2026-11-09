import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getSetupEnvVars } from './setup-hook-env-vars'

describe('getSetupEnvVars', () => {
  it('sets the workspace variables imported Conductor scripts read', () => {
    const env = getSetupEnvVars({ path: '/repos/acme' } as Repo, '/worktrees/acme/fix-login')
    expect(env).toMatchObject({
      CONDUCTOR_ROOT_PATH: '/repos/acme',
      CONDUCTOR_WORKSPACE_PATH: '/worktrees/acme/fix-login',
      CONDUCTOR_WORKSPACE_NAME: 'fix-login'
    })
  })
})
