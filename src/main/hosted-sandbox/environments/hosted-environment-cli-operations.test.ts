import { describe, expect, it, vi } from 'vitest'
import {
  followCloudEnvironmentBuild,
  resolveCloudEnvironment,
  setCloudEnvironmentInstallScript,
  showCloudEnvironment
} from './hosted-environment-cli-operations'
import type { HostedEnvironmentBuildFollowers } from './hosted-environment-build-followers'
import type { HostedEnvironmentClient } from './hosted-environment-client'
import { toHostedEnvironmentError } from './hosted-environment-service'
import {
  BUILD_ID,
  ENV_ID,
  buildView,
  environmentEntry
} from './hosted-environment-fixtures.test-support'

const OTHER_ID = 'env_ffffffffffffffffffff'

function fakeClient(overrides: Partial<HostedEnvironmentClient> = {}): HostedEnvironmentClient {
  const client: HostedEnvironmentClient = {
    list: vi.fn(async () => ({
      environments: [environmentEntry(), environmentEntry({ id: OTHER_ID, name: 'Mobile' })],
      canAdmin: true
    })),
    get: vi.fn(async () => ({
      environment: environmentEntry(),
      builds: [buildView({ number: 4, id: 'bld_aaaaaaaaaaaaaaaa' }), buildView()],
      canAdmin: true
    })),
    create: vi.fn(),
    update: vi.fn(async () => environmentEntry({ revision: 3 })),
    remove: vi.fn(),
    startBuild: vi.fn(),
    getBuild: vi.fn(),
    cancelBuild: vi.fn(),
    activateBuild: vi.fn(),
    staleness: vi.fn(async () => {
      throw new Error('github down')
    }),
    openBuildEvents: vi.fn(),
    ...overrides
  }
  return client
}

describe('hosted environment CLI operations', () => {
  it('picks the first environment by default, else by id or case-insensitive name', async () => {
    const client = fakeClient()
    expect((await resolveCloudEnvironment(client, undefined)).entry.id).toBe(ENV_ID)
    expect((await resolveCloudEnvironment(client, OTHER_ID)).entry.name).toBe('Mobile')
    expect((await resolveCloudEnvironment(client, 'mobile')).entry.id).toBe(OTHER_ID)
    const missing = await resolveCloudEnvironment(client, 'nope').catch((e: unknown) => e)
    expect(toHostedEnvironmentError(missing).message).toBe(
      'No environment named "nope". Known: Web, Mobile.'
    )
  })

  it('sends only the install script, guarded by the revision it read', async () => {
    const client = fakeClient()
    await setCloudEnvironmentInstallScript(client, undefined, 'npm ci\n')
    expect(client.update).toHaveBeenCalledWith(ENV_ID, {
      installScript: 'npm ci\n',
      expectedRevision: 2
    })
  })

  it('shows the environment even when the staleness check fails', async () => {
    const data = await showCloudEnvironment(fakeClient(), undefined)
    expect(data.staleness).toBeNull()
    expect(data.environment).not.toHaveProperty('activeBuild')
    expect(data.environments).toEqual([
      { id: ENV_ID, name: 'Web' },
      { id: OTHER_ID, name: 'Mobile' }
    ])
  })

  it('resolves a build number to its id before following', async () => {
    const poll = vi.fn(async () => ({
      build: null,
      chunks: [],
      cursor: 0,
      truncated: false,
      done: false,
      error: null
    }))
    const followers: HostedEnvironmentBuildFollowers = { poll, dispose: vi.fn() }
    const client = fakeClient()
    await followCloudEnvironmentBuild(client, followers, { build: '3' })
    expect(poll).toHaveBeenLastCalledWith(client, ENV_ID, BUILD_ID, 0, 0)
    const unknown = await followCloudEnvironmentBuild(client, followers, { build: '99' }).catch(
      (e: unknown) => e
    )
    expect(toHostedEnvironmentError(unknown).code).toBe('not_found')
  })
})
