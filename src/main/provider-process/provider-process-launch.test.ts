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

  it('keeps the launch PATH ahead of an inherited case variant on Windows', () => {
    const childEnv = resolveProviderChildEnv(
      { env: { Path: 'C:\\shim;C:\\Windows\\System32' }, envToDelete: [] },
      { PATH: 'C:\\Git\\usr\\bin;C:\\Windows\\System32' },
      'win32'
    )

    expect(childEnv).toEqual({ Path: 'C:\\shim;C:\\Windows\\System32' })
  })

  it('selects the overlay PATH spelling Node will pass when the overlay has several', () => {
    const childEnv = resolveProviderChildEnv(
      { env: { Path: 'C:\\shim', PATH: 'C:\\configured;C:\\shim' }, envToDelete: [] },
      { Path: 'C:\\inherited' },
      'win32'
    )

    // Node sorts case variants, so PATH is the value the child actually receives.
    expect(childEnv).toEqual({ PATH: 'C:\\configured;C:\\shim' })
  })
})
