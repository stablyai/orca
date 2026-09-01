import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { NpmPackageInfoResult } from '../../shared/npm-package-info-types'
import type { Store } from '../persistence'

const { npmCliPackageViewMock, npmRegistryHttpLookupMock } = vi.hoisted(() => ({
  npmCliPackageViewMock: vi.fn(),
  npmRegistryHttpLookupMock: vi.fn()
}))

vi.mock('./npm-cli-package-view', () => ({ npmCliPackageView: npmCliPackageViewMock }))
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
    npmCliPackageViewMock.mockReset()
    npmRegistryHttpLookupMock.mockReset()
  })

  it('short-circuits to lookup-disabled without any npm or network call when the privacy setting is off', async () => {
    const service = createNpmPackageInfoService(
      fakeStore({ npmPackageInfoOnlineLookupsEnabled: false })
    )

    const result = await service.lookup({
      packageName: 'react',
      worktreeRoot: '/repo',
      executionHostId: 'local'
    })

    expect(result).toEqual({ status: 'lookup-disabled' })
    expect(npmCliPackageViewMock).not.toHaveBeenCalled()
    expect(npmRegistryHttpLookupMock).not.toHaveBeenCalled()
  })

  it('routes a local host through the npm CLI path', async () => {
    npmCliPackageViewMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      worktreeRoot: '/repo',
      executionHostId: 'local'
    })

    expect(result).toEqual(okResult)
    expect(npmCliPackageViewMock).toHaveBeenCalledWith('react', '/repo', expect.anything())
    expect(npmRegistryHttpLookupMock).not.toHaveBeenCalled()
  })

  it('routes an ssh host through the registry HTTP path, never the local CLI', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      worktreeRoot: '/repo',
      executionHostId: 'ssh:conn-1'
    })

    expect(result).toEqual(okResult)
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
    expect(npmCliPackageViewMock).not.toHaveBeenCalled()
  })

  it('routes a runtime host through the registry HTTP path', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      worktreeRoot: '/repo',
      executionHostId: 'runtime:env-1'
    })

    expect(result).toEqual(okResult)
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
    expect(npmCliPackageViewMock).not.toHaveBeenCalled()
  })

  it('falls back to the registry HTTP path when the local host has no resolvable npm binary', async () => {
    npmCliPackageViewMock.mockResolvedValue({ status: 'npm-unresolvable' })
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      worktreeRoot: '/repo',
      executionHostId: 'local'
    })

    expect(result).toEqual(okResult)
    expect(npmCliPackageViewMock).toHaveBeenCalledTimes(1)
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
  })
})
