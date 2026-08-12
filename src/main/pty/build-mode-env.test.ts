import { describe, expect, it } from 'vitest'
import { stripInheritedBuildModeEnv } from './build-mode-env'

describe('stripInheritedBuildModeEnv', () => {
  it('drops NODE_ENV while keeping every other inherited variable', () => {
    const env = { NODE_ENV: 'development', PATH: '/usr/bin', HOME: '/home/tester' }

    expect(stripInheritedBuildModeEnv(env)).toEqual({ PATH: '/usr/bin', HOME: '/home/tester' })
  })

  it('does not mutate the source env', () => {
    const env = { NODE_ENV: 'development' }

    stripInheritedBuildModeEnv(env)

    expect(env.NODE_ENV).toBe('development')
  })

  it('is a no-op when NODE_ENV is unset', () => {
    expect(stripInheritedBuildModeEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})
