import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { NpmPackageInfoResult } from '../../shared/npm-package-info-types'
import type { Store } from '../persistence'

const { npmRegistryHttpLookupMock } = vi.hoisted(() => ({
  npmRegistryHttpLookupMock: vi.fn()
}))

vi.mock('./npm-registry-http-lookup', () => ({
  npmRegistryHttpLookup: npmRegistryHttpLookupMock
}))

const { createNpmPackageInfoService } = await import('./npm-package-info-service')

const okResult: NpmPackageInfoResult = {
  status: 'ok',
  info: {
    packageName: 'react',
    description: null,
    latestVersion: '19.0.0',
    latestPublishedAt: null,
    homepageUrl: null,
    repositoryUrl: null,
    source: 'registry-http'
  }
}

function fakeStore(overrides: Partial<GlobalSettings> = {}): Store {
  return {
    getSettings: () => overrides as GlobalSettings
  } as unknown as Store
}

describe('createNpmPackageInfoService', () => {
  beforeEach(() => {
    npmRegistryHttpLookupMock.mockReset()
  })

  it('short-circuits to lookup-disabled without any npm or network call when the privacy setting is off', async () => {
    const service = createNpmPackageInfoService(
      fakeStore({ npmPackageInfoOnlineLookupsEnabled: false })
    )

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local'
    })

    expect(result).toEqual({ status: 'lookup-disabled' })
    expect(npmRegistryHttpLookupMock).not.toHaveBeenCalled()
  })

  // Why every host, including local: npm reads its configuration from the
  // workspace, so a checked-in `.npmrc` decides which host `npm view` talks to.
  // Until an explicit workspace-trust decision exists, no execution host gets
  // the local CLI.
  it('routes a local host through the registry HTTP path', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local'
    })

    expect(result).toEqual(okResult)
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
  })

  it('routes an ssh host through the registry HTTP path, never the local CLI', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'ssh:conn-1'
    })

    expect(result).toEqual(okResult)
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
  })

  it('routes a runtime host through the registry HTTP path', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'runtime:env-1'
    })

    expect(result).toEqual(okResult)
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
  })
})
