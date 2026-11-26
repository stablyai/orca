import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { directoryAccountBinding } from './acp-account-binding'

describe('directoryAccountBinding', () => {
  it('keeps the selected account when the launch environment changes', async () => {
    const binding = directoryAccountBinding('AGENT_HOME', (homePath) => join(homePath, '.agent'))
    const home = await binding.resolve({
      launchEnv: { AGENT_HOME: '/selected' },
      stateDirectory: '/state'
    })

    expect(binding.environment(home, { AGENT_HOME: '/different' })).toMatchObject({
      AGENT_HOME: '/selected'
    })
  })

  it('pins a fixed account home when the agent ignores directory overrides', async () => {
    const binding = directoryAccountBinding('AGENT_HOME', (homePath) => join(homePath, '.agent'), {
      allowOverride: false
    })
    const home = await binding.resolve({
      launchEnv: { AGENT_HOME: '/ignored' },
      stateDirectory: '/state'
    })

    expect(home).not.toEqual({ variable: 'AGENT_HOME', path: '/ignored' })
    if (!('path' in home)) {
      throw new Error('expected a directory account home')
    }
    expect(binding.environment(home, { AGENT_HOME: '/ignored' })).toMatchObject({
      AGENT_HOME: home.path
    })
    expect(() => binding.environment({ variable: 'AGENT_HOME', path: '/other' }, {})).toThrow(
      `sessions of this agent pin ${home.path}`
    )
  })

  it("derives a fixed account home from the child process's home", async () => {
    const binding = directoryAccountBinding('AGENT_HOME', (homePath) => join(homePath, '.agent'), {
      allowOverride: false
    })
    const childHome = '/child-home'
    const launchEnv: Record<string, string> =
      process.platform === 'win32' ? { USERPROFILE: childHome } : { HOME: childHome }
    const home = await binding.resolve({ launchEnv, stateDirectory: '/state' })

    expect(home).toEqual({ variable: 'AGENT_HOME', path: join(childHome, '.agent') })
    expect(binding.environment(home, launchEnv)).toMatchObject({
      AGENT_HOME: join(childHome, '.agent')
    })
  })

  it("preserves whitespace in the child process's home", async () => {
    const binding = directoryAccountBinding('AGENT_HOME', (homePath) => join(homePath, '.agent'), {
      allowOverride: false
    })
    const childHome = '/child-home '
    const launchEnv: Record<string, string> =
      process.platform === 'win32' ? { USERPROFILE: childHome } : { HOME: childHome }

    await expect(binding.resolve({ launchEnv, stateDirectory: '/state' })).resolves.toEqual({
      variable: 'AGENT_HOME',
      path: join(childHome, '.agent')
    })
  })
})
