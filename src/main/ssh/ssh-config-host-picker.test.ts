import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SshConfigParser from './ssh-config-parser'
import type { SshConfigHost } from './ssh-config-parser'

const loadUserSshConfigMock = vi.hoisted(() => vi.fn<() => SshConfigHost[]>(() => []))
vi.mock('./ssh-config-parser', async (importOriginal) => ({
  ...(await importOriginal<typeof SshConfigParser>()),
  loadUserSshConfig: loadUserSshConfigMock
}))

import { SSH_CONFIG_HOST_RESULT_LIMIT } from '../../shared/ssh-types'
import {
  invalidateUserSshConfigHostCache,
  listUserSshConfigHostSummaries,
  resolveUserSshConfigHost,
  searchSshConfigHosts
} from './ssh-config-host-picker'
import type { SshResolvedConfig } from './ssh-g-config-resolution'

function resolved(overrides: Partial<SshResolvedConfig> = {}): SshResolvedConfig {
  return {
    hostname: 'prod.internal',
    user: 'deploy',
    port: 2222,
    identityFile: ['/keys/first', '/keys/second'],
    identitiesOnly: true,
    forwardAgent: false,
    gssapiAuthentication: true,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    userKnownHostsFiles: [],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask',
    hashKnownHosts: false,
    updateHostKeys: 'no',
    ...overrides
  }
}

describe('SSH config host picker search', () => {
  it('bounds results while searching aliases beyond the first page', () => {
    const hosts = Array.from({ length: 150_000 }, (_, index) => ({
      host: `generated-${index}`
    }))
    const initial = searchSshConfigHosts(hosts, [])
    const last = searchSshConfigHosts(hosts, [], 'generated-149999')

    expect(initial.hosts).toHaveLength(SSH_CONFIG_HOST_RESULT_LIMIT)
    expect(initial).toMatchObject({
      totalHostCount: 150_000,
      newHostCount: 150_000,
      matchCount: 150_000,
      hasMore: true
    })
    expect(last.hosts.map((host) => host.alias)).toEqual(['generated-149999'])
    expect(last.hasMore).toBe(false)
  })

  it('counts de-duplicated and existing aliases while matching effective display fields', () => {
    const result = searchSshConfigHosts(
      [
        { host: 'prod', hostname: 'prod.internal', user: 'deploy' },
        { host: 'prod', hostname: 'ignored.internal' },
        { host: 'stage', hostname: 'stage.internal', user: 'ops' }
      ],
      [{ configHost: 'prod', label: 'Production' }],
      'internal'
    )

    expect(result).toMatchObject({
      totalHostCount: 2,
      newHostCount: 1,
      matchCount: 2,
      hasMore: false
    })
    expect(result.hosts[0]).toMatchObject({ alias: 'prod', alreadyInOrca: true })
  })

  it('marks a case-only alias variant as already in Orca', () => {
    const result = searchSshConfigHosts([{ host: 'prod' }], [{ configHost: 'Prod', label: 'Prod' }])

    expect(result).toMatchObject({ totalHostCount: 1, newHostCount: 0 })
    expect(result.hosts[0]).toMatchObject({ alias: 'prod', alreadyInOrca: true })
  })

  it('lists suppressed aliases for re-pick but excludes them from Add-all newHostCount', () => {
    const result = searchSshConfigHosts([{ host: 'removed' }, { host: 'active' }], [], '', [
      'removed'
    ])

    expect(result).toMatchObject({ totalHostCount: 2, newHostCount: 1, matchCount: 2 })
    expect(result.hosts).toEqual([
      expect.objectContaining({ alias: 'removed', previouslyRemoved: true, alreadyInOrca: false }),
      expect.objectContaining({ alias: 'active', alreadyInOrca: false })
    ])
    expect(result.hosts.find((host) => host.alias === 'active')?.previouslyRemoved).toBeUndefined()
  })

  it('does not mark a host as previously removed when it is already in Orca', () => {
    const result = searchSshConfigHosts(
      [{ host: 'prod' }],
      [{ configHost: 'prod', label: 'Production' }],
      '',
      ['prod']
    )

    expect(result.hosts[0]).toMatchObject({
      alias: 'prod',
      alreadyInOrca: true
    })
    expect(result.hosts[0]?.previouslyRemoved).toBeUndefined()
    expect(result.newHostCount).toBe(0)
  })
})

describe('listUserSshConfigHostSummaries caching', () => {
  beforeEach(() => {
    loadUserSshConfigMock.mockClear()
    loadUserSshConfigMock.mockReturnValue([{ host: 'prod' }, { host: 'stage' }])
    invalidateUserSshConfigHostCache()
  })

  it('parses ~/.ssh/config once per picker session and filters in memory', () => {
    listUserSshConfigHostSummaries([], '', [], { refresh: true })
    const filtered = listUserSshConfigHostSummaries([], 'stage')
    listUserSshConfigHostSummaries([], 'sta')

    expect(loadUserSshConfigMock).toHaveBeenCalledTimes(1)
    expect(filtered.hosts.map((host) => host.alias)).toEqual(['stage'])
  })

  it('re-reads the file when the picker reopens', () => {
    listUserSshConfigHostSummaries([], '', [], { refresh: true })
    loadUserSshConfigMock.mockReturnValue([{ host: 'prod' }, { host: 'stage' }, { host: 'added' }])
    const reopened = listUserSshConfigHostSummaries([], '', [], { refresh: true })

    expect(loadUserSshConfigMock).toHaveBeenCalledTimes(2)
    expect(reopened.totalHostCount).toBe(3)
  })
})

describe('resolveUserSshConfigHost', () => {
  it('returns effective endpoint and the complete authentication contract', async () => {
    const resolver = vi.fn().mockResolvedValue(resolved())

    await expect(
      resolveUserSshConfigHost('prod', resolver, () => [
        { host: 'prod', gssapiAuthentication: true }
      ])
    ).resolves.toEqual({
      alias: 'prod',
      hostname: 'prod.internal',
      username: 'deploy',
      port: 2222,
      identityFiles: ['/keys/first', '/keys/second'],
      identitiesOnly: true,
      forwardAgent: false,
      gssapiAuthentication: true,
      proxyUseFdpass: false
    })
    expect(resolver).toHaveBeenCalledWith('prod')
  })

  it('ignores the system-wide GSSAPIAuthentication default that ssh -G reports', async () => {
    const resolver = vi.fn().mockResolvedValue(resolved())

    await expect(
      resolveUserSshConfigHost('prod', resolver, () => [
        { host: 'prod', hostname: 'prod.internal' }
      ])
    ).resolves.toMatchObject({ gssapiAuthentication: false })
  })

  it('honours a case-only variant of the Host entry that requests GSSAPI', async () => {
    const resolver = vi.fn().mockResolvedValue(resolved())

    await expect(
      resolveUserSshConfigHost('PROD', resolver, () => [
        { host: 'prod', gssapiAuthentication: true }
      ])
    ).resolves.toMatchObject({ gssapiAuthentication: true })
  })

  it('returns null for an alias the config no longer declares, even though ssh -G answers', async () => {
    const resolver = vi.fn().mockResolvedValue(resolved({ hostname: 'deleted' }))

    await expect(
      resolveUserSshConfigHost('deleted', resolver, () => [{ host: 'prod' }])
    ).resolves.toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('returns null when OpenSSH cannot resolve an endpoint', async () => {
    await expect(
      resolveUserSshConfigHost(
        'missing',
        async () => null,
        () => [{ host: 'missing' }]
      )
    ).resolves.toBeNull()
  })
})
