import { describe, expect, it, vi } from 'vitest'
import { SSH_CONFIG_HOST_RESULT_LIMIT } from '../../../shared/remote-runtime/ssh/ssh-types'
import { resolveUserSshConfigHost, searchSshConfigHosts } from './ssh-config-host-picker'
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

  it('marks an alias the import skips as a route duplicate In Orca and leaves it out of Add all', () => {
    const result = searchSshConfigHosts(
      [{ host: 'aimp' }, { host: 'fresh' }],
      [{ configHost: '172.16.203.131', label: 'AI Box' }],
      '',
      [],
      new Set(['aimp'])
    )

    expect(result.hosts.map(({ alias, alreadyInOrca }) => [alias, alreadyInOrca])).toEqual([
      ['aimp', true],
      ['fresh', false]
    ])
    expect(result.newHostCount).toBe(1)
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
})

describe('resolveUserSshConfigHost', () => {
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
})
