import { describe, expect, it } from 'vitest'
import { WindowsShellPathOwnership } from './windows-shell-path-ownership'

describe('Windows shell PATH ownership', () => {
  it.each(['PATH', 'Path'])(
    'restores the complete %s baseline without changing its casing',
    (key) => {
      const env: Record<string, string | undefined> = {
        [key]: 'C:\\B;c:\\b;C:\\;\\\\Server\\Share\\'
      }
      const ownership = new WindowsShellPathOwnership()
      ownership.apply(env, 'C:\\Profile;C:\\B;C:\\;\\\\Server\\Share\\')

      ownership.restore(env)

      expect(env).toEqual({ [key]: 'C:\\B;c:\\b;C:\\;\\\\Server\\Share\\' })
    }
  )

  it('preserves PATH entries appended outside shell hydration', () => {
    const env = { Path: 'C:\\B;C:\\A' }
    const ownership = new WindowsShellPathOwnership()
    ownership.apply(env, 'C:\\Profile;C:\\A;C:\\B')
    env.Path += ';C:\\NewlyInstalled'

    ownership.restore(env)

    expect(env.Path).toBe('C:\\B;C:\\A;C:\\NewlyInstalled')
  })

  it('updates the first effective key when both Windows casings exist', () => {
    const env = { Path: 'C:\\B;C:\\A', PATH: 'C:\\ignored' }
    const ownership = new WindowsShellPathOwnership()
    ownership.apply(env, 'C:\\Profile;C:\\A;C:\\B')

    ownership.restore(env)

    expect(env).toEqual({ Path: 'C:\\B;C:\\A', PATH: 'C:\\ignored' })
  })
})
