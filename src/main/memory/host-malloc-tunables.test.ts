import { afterEach, describe, expect, it } from 'vitest'
import {
  claimHostMallocTunables,
  HOST_MALLOC_TUNABLES,
  hostMallocTunablesDaemonEnv,
  hostMallocTunablesLaunchEnv,
  resetHostMallocTunablesForTests
} from './host-malloc-tunables'

afterEach(() => resetHostMallocTunablesForTests())

describe('host malloc tunables', () => {
  it('removes what the launch set from this process, and keeps it only for the daemon', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/bin',
      ...Object.fromEntries(hostMallocTunablesLaunchEnv())
    }
    claimHostMallocTunables(env)
    expect(env).toEqual({ PATH: '/bin' })
    expect(hostMallocTunablesDaemonEnv()).toEqual(Object.fromEntries(hostMallocTunablesLaunchEnv()))
  })

  it('never touches tunables the user set', () => {
    const env: NodeJS.ProcessEnv = { GLIBC_TUNABLES: 'glibc.malloc.arena_max=2' }
    claimHostMallocTunables(env)
    expect(env).toEqual({ GLIBC_TUNABLES: 'glibc.malloc.arena_max=2' })
    expect(hostMallocTunablesDaemonEnv()).toEqual({})
  })

  it('keeps a user value that replaced the launch’s, dropping only the marker', () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(hostMallocTunablesLaunchEnv()),
      GLIBC_TUNABLES: 'glibc.malloc.arena_max=2'
    }
    claimHostMallocTunables(env)
    expect(env).toEqual({ GLIBC_TUNABLES: 'glibc.malloc.arena_max=2' })
    expect(hostMallocTunablesDaemonEnv()).toEqual({})
  })

  it('gives the daemon nothing in a process the launch did not tune', () => {
    claimHostMallocTunables({})
    expect(hostMallocTunablesDaemonEnv()).toEqual({})
    expect(HOST_MALLOC_TUNABLES).toContain('mmap_threshold')
  })
})
