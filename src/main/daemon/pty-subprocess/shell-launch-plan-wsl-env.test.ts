import { describe, expect, it } from 'vitest'
import { applyWslSpawnEnv } from './shell-launch-plan'
import { ORCA_PTY_TREE_ID_ENV } from '../../pty/wsl-orca-env'

describe('applyWslSpawnEnv', () => {
  it('stamps the session marker before registering WSLENV imports', () => {
    const env: Record<string, string> = {}
    applyWslSpawnEnv(env, 'repo::C:\\work@@a1b2c3d4')
    expect(env[ORCA_PTY_TREE_ID_ENV]).toBe('repo::C:\\work@@a1b2c3d4')
    expect(env.WSLENV?.split(':')).toContain(`${ORCA_PTY_TREE_ID_ENV}/u`)
  })
})
