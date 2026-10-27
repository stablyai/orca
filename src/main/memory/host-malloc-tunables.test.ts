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
  it('launches with the mmap threshold glibc reads at exec', () => {
    expect(Object.fromEntries(hostMallocTunablesLaunchEnv()).GLIBC_TUNABLES).toBe(
      'glibc.malloc.mmap_threshold=16384'
    )
  })

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

describe('host process entries', () => {
  it.each(['../orcad/main.ts', '../daemon/daemon-entry.ts'])(
    '%s claims the tunables before importing anything that could start a child',
    async (entry) => {
      const { readFile } = await import('node:fs/promises')
      const source = await readFile(new URL(entry, import.meta.url), 'utf8')
      expect(source.match(/^import .*$/m)?.[0]).toBe(
        "import '../memory/host-malloc-tunables-claim'"
      )
    }
  )
})
