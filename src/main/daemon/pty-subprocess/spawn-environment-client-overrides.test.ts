import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment, finalizeDaemonPtyEnvironment } from './spawn-environment'

const spawn = { sessionId: 'override-test', cols: 80, rows: 24 }
afterEach(() => vi.unstubAllEnvs())

describe('daemon client environment authority', () => {
  it('preserves an explicit wizard preference and honors deletion of its default', () => {
    expect(
      createDaemonPtyEnvironment({
        ...spawn,
        env: { POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD: 'already-set' }
      }).POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD
    ).toBe('already-set')
    expect(
      createDaemonPtyEnvironment({
        ...spawn,
        envToDelete: ['POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD']
      }).POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD
    ).toBeUndefined()
  })

  it('does not resurrect stale inherited Git config slots behind an explicit smaller count', () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '2')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'base.zero')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'zero')
    vi.stubEnv('GIT_CONFIG_KEY_1', 'base.one')
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'one')
    const env = createDaemonPtyEnvironment({
      ...spawn,
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'override.zero',
        GIT_CONFIG_VALUE_0: 'override'
      }
    })
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('override.zero')
    expect(env.GIT_CONFIG_VALUE_0).toBe('override')
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined()
  })

  it('drops the activation sentinel after the client removes CONDA_PREFIX', () => {
    vi.stubEnv('CONDA_SHLVL', '1')
    vi.stubEnv('CONDA_PREFIX', '/opt/miniconda3')
    vi.stubEnv('CONDA_DEFAULT_ENV', 'base')
    const env = createDaemonPtyEnvironment({ ...spawn, envToDelete: ['CONDA_PREFIX'] })
    finalizeDaemonPtyEnvironment(env, undefined)
    expect(env.CONDA_PREFIX).toBeUndefined()
    expect(env.CONDA_SHLVL).toBeUndefined()
    expect(env.CONDA_DEFAULT_ENV).toBeUndefined()
  })

  it('does not re-promote a legacy attribution path for Agent Teams', () => {
    const env = createDaemonPtyEnvironment({
      ...spawn,
      env: {
        PATH: '/tmp/orca-terminal-attribution/posix:/usr/bin',
        ORCA_AGENT_TEAMS_TEAM_ID: 'team-test'
      }
    })
    expect(env.PATH).toBe('/usr/bin')
  })
})
