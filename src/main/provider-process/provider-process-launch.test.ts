import { describe, expect, it } from 'vitest'
import { resolveProviderChildEnv } from './provider-process-launch'

describe('resolveProviderChildEnv', () => {
  it('overlays the launch env on the inherited env, then strips deleted keys', () => {
    const baseEnv = { PATH: '/bin', AGENT_HOME: '/inherited', PARENT_AGENT: 'parent' }
    const overlay = { AGENT_HOME: '/pinned', LAUNCH_ONLY: 'added', PARENT_AGENT: 'overlay' }

    const childEnv = resolveProviderChildEnv(
      { env: overlay, envToDelete: ['PARENT_AGENT'] },
      baseEnv
    )

    expect(childEnv).toEqual({ PATH: '/bin', AGENT_HOME: '/pinned', LAUNCH_ONLY: 'added' })
    expect(baseEnv).toEqual({ PATH: '/bin', AGENT_HOME: '/inherited', PARENT_AGENT: 'parent' })
    expect(overlay.PARENT_AGENT).toBe('overlay')
  })

  it('copies the inherited env when the launch carries no env', () => {
    const baseEnv = { PATH: '/bin' }

    const childEnv = resolveProviderChildEnv({}, baseEnv)

    expect(childEnv).toEqual(baseEnv)
    expect(childEnv).not.toBe(baseEnv)
  })
})
