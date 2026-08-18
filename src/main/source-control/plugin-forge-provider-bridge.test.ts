import { describe, expect, it, vi } from 'vitest'
import type { ForgeProvider, ForgeProviderRepositoryContext } from './forge-provider'
import {
  bindPluginForgeProviderResolvers,
  getPluginProviderByHost,
  getPluginProviderById,
  hostFromRemoteUrl,
  resolvePluginForgeProvider
} from './plugin-forge-provider-bridge'

vi.mock('../git/remote-url-probe', () => ({
  readRemoteUrl: vi.fn(async () => 'https://git.corp.example/acme/app.git')
}))

function provider(id: string): ForgeProvider {
  return {
    id,
    supportsReviewCreation: true,
    resolveRepository: vi.fn(async () => ({ owner: 'acme', repo: 'app' })),
    getReviewForBranch: vi.fn(async () => null),
    getReviewByNumber: vi.fn(async () => null)
  }
}

const hostRegistry = {
  getByProviderId: (id: string) => (id === 'corpforge' ? provider('corpforge') : null),
  findByHost: (host: string) =>
    host.toLowerCase() === 'git.corp.example' ? { provider: provider('corpforge') } : null
}

describe('hostFromRemoteUrl', () => {
  it('parses https, ssh, and scp-like remote urls', () => {
    expect(hostFromRemoteUrl('https://Git.Corp.Example:8443/acme/app.git')).toBe(
      'git.corp.example:8443'
    )
    expect(hostFromRemoteUrl('ssh://git@git.corp.example/acme/app.git')).toBe('git.corp.example')
    expect(hostFromRemoteUrl('git@git.corp.example:acme/app.git')).toBe('git.corp.example')
  })

  it('preserves explicit ports in scp-like remotes', () => {
    expect(hostFromRemoteUrl('ssh://git@git.corp.example:2222/acme/app.git')).toBe(
      'git.corp.example:2222'
    )
    expect(hostFromRemoteUrl('git@git.corp.example:2222:acme/app.git')).toBe(
      'git.corp.example:2222'
    )
  })

  it('normalizes default ports (443, 80) away via URL.host convention', () => {
    expect(hostFromRemoteUrl('https://git.corp.example:443/acme/app.git')).toBe('git.corp.example')
    expect(hostFromRemoteUrl('http://git.corp.example:80/acme/app.git')).toBe('git.corp.example')
  })

  it('returns null for unparseable inputs', () => {
    expect(hostFromRemoteUrl('not a url')).toBeNull()
    expect(hostFromRemoteUrl('')).toBeNull()
  })
})

describe('bindPluginForgeProviderResolvers', () => {
  it('routes provider-id lookups through the registry', () => {
    bindPluginForgeProviderResolvers(hostRegistry)
    expect(getPluginProviderById('corpforge')?.id).toBe('corpforge')
    expect(getPluginProviderById('missing')).toBeNull()
  })

  it('routes host lookups through the registry case-insensitively', () => {
    bindPluginForgeProviderResolvers(hostRegistry)
    expect(getPluginProviderByHost('GIT.CORP.EXAMPLE')?.id).toBe('corpforge')
    expect(getPluginProviderByHost('other.example')).toBeNull()
  })

  it('resolves a plugin provider only after confirming the repository', async () => {
    const confirmed = {
      getByProviderId: () => null,
      findByHost: (host: string) =>
        host.toLowerCase() === 'git.corp.example' ? { provider: provider('corpforge') } : null
    }
    bindPluginForgeProviderResolvers(confirmed)
    const context = { repoPath: '/tmp/repo' } as ForgeProviderRepositoryContext
    expect((await resolvePluginForgeProvider(context))?.id).toBe('corpforge')
  })
})
