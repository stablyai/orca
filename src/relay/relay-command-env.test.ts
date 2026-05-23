import { describe, expect, it } from 'vitest'
import { buildRelayCommandEnv } from './relay-command-env'

describe('buildRelayCommandEnv', () => {
  it('adds POSIX git locations when the relay starts with an empty PATH', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '' }, 'linux')

    expect(env.PATH?.split(':')).toEqual(
      expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin'])
    )
    expect(env.HOME).toBe('/home/me')
  })

  it('preserves Windows Path casing and adds Git install locations', () => {
    const env = buildRelayCommandEnv({ Path: 'C:\\Tools' }, 'win32')

    expect(env.PATH).toBeUndefined()
    expect(env.Path?.split(';')).toEqual(
      expect.arrayContaining(['C:\\Tools', 'C:\\Program Files\\Git\\cmd'])
    )
  })
})
