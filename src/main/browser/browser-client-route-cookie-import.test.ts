import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  bindingStore,
  detectInstalledBrowsersMock,
  getProfileMock,
  getRouteIdentityMock,
  importCookiesFromBrowserMock,
  requireRouteBrowserProfileMock,
  recordClientRouteImportSourceMock,
  selectBrowserProfileMock
} = vi.hoisted(() => ({
  bindingStore: {
    get: vi.fn(() => null as string | null),
    set: vi.fn(() => [] as readonly string[]),
    touch: vi.fn(),
    findPartitionByFingerprint: vi.fn(() => null as string | null),
    rebind: vi.fn()
  },
  detectInstalledBrowsersMock: vi.fn(),
  getProfileMock: vi.fn(),
  getRouteIdentityMock: vi.fn(),
  importCookiesFromBrowserMock: vi.fn(),
  requireRouteBrowserProfileMock: vi.fn(),
  recordClientRouteImportSourceMock: vi.fn(),
  selectBrowserProfileMock: vi.fn()
}))

vi.mock('./browser-cookie-import', () => ({
  detectInstalledBrowsers: detectInstalledBrowsersMock,
  importCookiesFromBrowser: importCookiesFromBrowserMock,
  selectBrowserProfile: selectBrowserProfileMock
}))
vi.mock('./browser-route-partition-binding-runtime', () => ({
  currentBrowserRoutePartitionBindingStore: () => bindingStore
}))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: getProfileMock,
    requireRouteBrowserProfile: requireRouteBrowserProfileMock
  }
}))
vi.mock('./client-route-cookie-import-source-store', () => ({
  recordClientRouteCookieImportSource: recordClientRouteImportSourceMock
}))
vi.mock('./paired-runtime-browser-client-host-runtime', () => ({
  getPairedRuntimeBrowserClientRouteIdentity: getRouteIdentityMock
}))

const { importCookiesIntoClientRoutePartition } =
  await import('./browser-client-route-cookie-import')

const routeIdentity = {
  orcaProfileId: 'orca-profile-a',
  authorityConnectionIdentity: 'paired-runtime:authority-a',
  executionHostIdentity: 'execution-host-a',
  legacyAuthorityConnectionIdentity: 'paired-runtime:legacy-authority-a',
  legacyExecutionHostIdentity: 'legacy-execution-host-a',
  storageScope: 'e'.repeat(64)
}

/** The same server after a re-pair: a different durable identity, so a different partition. */
const repairedRouteIdentity = {
  ...routeIdentity,
  authorityConnectionIdentity: 'paired-runtime:authority-b'
}

const chrome = {
  family: 'chrome',
  label: 'Chrome',
  profiles: [{ name: 'Person 1', directory: 'Default' }],
  selectedProfile: 'Default'
}

const request = {
  environmentId: 'env-a',
  browserProfileId: 'default',
  browserFamily: 'chrome'
}

beforeEach(() => {
  vi.clearAllMocks()
  bindingStore.get.mockReturnValue(null)
  getRouteIdentityMock.mockReturnValue(routeIdentity)
  getProfileMock.mockReturnValue({ id: 'default', partition: 'persist:legacy-server-profile' })
  detectInstalledBrowsersMock.mockReturnValue([chrome])
  importCookiesFromBrowserMock.mockResolvedValue({ ok: true, summary: { importedCookies: 4 } })
})

describe('importCookiesIntoClientRoutePartition', () => {
  it('imports into a main-derived route partition, never the server profile partition', async () => {
    const result = await importCookiesIntoClientRoutePartition(request)

    expect(result).toMatchObject({ ok: true, profileId: 'default' })
    expect(requireRouteBrowserProfileMock).toHaveBeenCalledWith('default')
    const [source, partition] = importCookiesFromBrowserMock.mock.calls[0] ?? []
    expect(source).toBe(chrome)
    expect(partition).toMatch(/^persist:orca-browser-v1-[a-f0-9]{64}$/)
    expect(bindingStore.set).toHaveBeenCalledWith(
      partition,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      routeIdentity.storageScope
    )
    expect(recordClientRouteImportSourceMock).toHaveBeenCalledWith({
      environmentId: 'env-a',
      profileId: 'default',
      source: {
        browserFamily: 'chrome',
        profileName: 'Person 1',
        importedAt: expect.any(Number)
      }
    })
  })

  it('defers to the server-side import when the desktop hosts no pages for the server', async () => {
    getRouteIdentityMock.mockReturnValue(null)

    expect(await importCookiesIntoClientRoutePartition(request)).toBeNull()
    expect(importCookiesFromBrowserMock).not.toHaveBeenCalled()
  })

  it('fails closed on a conflicting persisted binding', async () => {
    bindingStore.get.mockReturnValue('b'.repeat(64))

    expect(await importCookiesIntoClientRoutePartition(request)).toEqual({
      ok: false,
      reason: 'browser_route_partition_binding_conflict'
    })
    expect(importCookiesFromBrowserMock).not.toHaveBeenCalled()
  })

  it('rejects a traversing browser profile name before touching the filesystem', async () => {
    expect(
      await importCookiesIntoClientRoutePartition({ ...request, browserProfile: '../../etc' })
    ).toEqual({ ok: false, reason: 'Invalid browser profile name.' })
    expect(detectInstalledBrowsersMock).not.toHaveBeenCalled()
  })

  it('reselects a non-default desktop browser profile', async () => {
    const secondary = { ...chrome, selectedProfile: 'Profile 2' }
    selectBrowserProfileMock.mockReturnValue(secondary)

    await importCookiesIntoClientRoutePartition({ ...request, browserProfile: 'Profile 2' })

    expect(selectBrowserProfileMock).toHaveBeenCalledWith(chrome, 'Profile 2')
    expect(importCookiesFromBrowserMock.mock.calls[0]?.[0]).toBe(secondary)
  })

  it('leaves the profile source untouched when the import fails', async () => {
    importCookiesFromBrowserMock.mockResolvedValue({ ok: false, reason: 'locked database' })

    expect(await importCookiesIntoClientRoutePartition(request)).toEqual({
      ok: false,
      reason: 'locked database'
    })
    expect(recordClientRouteImportSourceMock).not.toHaveBeenCalled()
  })

  // Why: the import takes seconds; a host replacement inside that window retargets the route, so
  // reporting success would badge a partition none of the user's client-hosted tabs read from.
  it('fails the import when the server is re-paired mid-import', async () => {
    getRouteIdentityMock.mockReturnValueOnce(routeIdentity).mockReturnValue(repairedRouteIdentity)

    const result = await importCookiesIntoClientRoutePartition(request)

    expect(result).toEqual({
      ok: false,
      reason: 'This server was re-paired during the import. Try again.'
    })
    expect(importCookiesFromBrowserMock).toHaveBeenCalledOnce()
    expect(recordClientRouteImportSourceMock).not.toHaveBeenCalled()
  })

  it('fails the import when the client host is retired mid-import', async () => {
    getRouteIdentityMock.mockReturnValueOnce(routeIdentity).mockReturnValue(null)

    const result = await importCookiesIntoClientRoutePartition(request)

    expect(result).toEqual({
      ok: false,
      reason: 'The connection to this server ended during the import. Reconnect and try again.'
    })
    expect(recordClientRouteImportSourceMock).not.toHaveBeenCalled()
  })

  // Why: the durable identity outlives a remote restart, so a reconnect must not fail the import.
  it('still succeeds when only the authority runtime id changed during the import', async () => {
    getRouteIdentityMock.mockReturnValueOnce(routeIdentity).mockReturnValue({
      ...routeIdentity,
      legacyAuthorityConnectionIdentity: 'paired-runtime:legacy-authority-restarted',
      legacyExecutionHostIdentity: 'legacy-execution-host-restarted'
    })

    expect(await importCookiesIntoClientRoutePartition(request)).toMatchObject({ ok: true })
    expect(recordClientRouteImportSourceMock).toHaveBeenCalled()
  })

  it('rejects an unknown browser session profile', async () => {
    getProfileMock.mockReturnValue(null)

    expect(await importCookiesIntoClientRoutePartition(request)).toEqual({
      ok: false,
      reason: 'Session profile not found.'
    })
  })
})
