import { describe, expect, it } from 'vitest'
import { findHostProgram } from './acp-launch-command'

describe('findHostProgram', () => {
  it('keeps /mnt/<drive> paths on native Linux', async () => {
    const found = await findHostProgram('agy', { PATH: '/mnt/d/tools/bin:/usr/bin' }, [], {
      guestWindowsDriveMounts: [],
      isWslGuest: false,
      resolveCommand: async (_cmd, opts) => {
        const dirs = (opts?.pathEnv ?? '').split(':')
        return dirs.includes('/mnt/d/tools/bin') ? '/mnt/d/tools/bin/agy' : 'agy'
      }
    })
    expect(found).toBe('/mnt/d/tools/bin/agy')
  })

  it('skips Windows drive mounts in WSL and falls through to a Linux binary', async () => {
    const found = await findHostProgram(
      'agy',
      { PATH: '/mnt/c/Users/dev/bin:/usr/local/bin', WSL_DISTRO_NAME: 'Ubuntu' },
      [],
      {
        guestWindowsDriveMounts: ['/mnt/c'],
        isWslGuest: true,
        resolveCommand: async (_cmd, opts) => {
          const dirs = (opts?.pathEnv ?? '').split(':')
          if (dirs.includes('/mnt/c/Users/dev/bin')) {
            return '/mnt/c/Users/dev/bin/agy'
          }
          return dirs.includes('/usr/local/bin') ? '/usr/local/bin/agy' : 'agy'
        }
      }
    )
    expect(found).toBe('/usr/local/bin/agy')
  })

  it('rejects a /mnt/<drive> binary in a WSL guest without mount metadata', async () => {
    const found = await findHostProgram(
      'agy',
      { PATH: '/mnt/c/Users/dev/bin', WSL_DISTRO_NAME: 'Ubuntu' },
      [],
      {
        guestWindowsDriveMounts: [],
        isWslGuest: true,
        resolveCommand: async () => '/mnt/c/Users/dev/bin/agy'
      }
    )
    expect(found).toBeNull()
  })
})
