import { describe, expect, it, vi } from 'vitest'
import {
  BrowserHostPagePlacementRegistry,
  type RuntimeBrowserClientPlacement
} from './browser-host-page-placement'
import {
  closeRuntimeBrowserClientPage,
  createRuntimeBrowserClientPage,
  navigateRuntimeBrowserClientPage
} from './runtime-browser-client-page-creation'

type ClientPageAuthority = Parameters<typeof closeRuntimeBrowserClientPage>[0]

describe('runtime browser client page creation', () => {
  it('uses the stable page and exact execution host for create proof', async () => {
    const createProof = deferred<RuntimeBrowserClientPlacement>()
    const authority = createAuthority({
      createClientPage: vi.fn(() => createProof.promise),
      issueClientPageCommand: vi.fn()
    })

    const creation = createRuntimeBrowserClientPage(authority, {
      browserPageId: 'page-stable',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-a',
      executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 7 }
    })

    expect(authority.createClientPage).toHaveBeenCalledWith({
      browserPageId: 'page-stable',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-a',
      executionHostKey: JSON.stringify(['native', 'runtime-a', 7]),
      requiredCapabilities: ['automation-v1']
    })
    expect(authority.issueClientPageCommand).not.toHaveBeenCalled()
    createProof.resolve(clientPlacement())

    await expect(creation).resolves.toEqual({
      browserPageId: 'page-stable',
      placement: clientPlacement()
    })
    expect(authority.issueClientPageCommand).not.toHaveBeenCalled()
  })

  it('does not navigate or attempt another placement after client creation fails', async () => {
    const authority = createAuthority({
      createClientPage: vi.fn(async () => {
        throw new Error('browser_client_page_mount_failed')
      }),
      issueClientPageCommand: vi.fn()
    })

    await expect(
      createRuntimeBrowserClientPage(authority, {
        browserPageId: 'page-stable',
        browserHostClientId: 'host-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'default',
        executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 7 }
      })
    ).rejects.toThrow('browser_client_page_mount_failed')
    expect(authority.issueClientPageCommand).not.toHaveBeenCalled()
  })

  it('navigates only the exact proven client placement', async () => {
    const authority = createAuthority({
      issueClientPageCommand: vi.fn(() => ({
        event: {} as never,
        result: Promise.resolve({ status: 'completed' as const })
      }))
    })

    await expect(
      navigateRuntimeBrowserClientPage(authority, {
        browserPageId: 'page-stable',
        placement: clientPlacement(),
        url: 'https://remote.internal/'
      })
    ).resolves.toBeUndefined()
    expect(authority.issueClientPageCommand).toHaveBeenCalledWith(
      {
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserPageId: 'page-stable',
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      },
      { type: 'navigate', url: 'https://remote.internal/' }
    )
  })

  it('surfaces failed navigation without creating or replacing the page', async () => {
    const authority = createAuthority({
      issueClientPageCommand: vi.fn(() => ({
        event: {} as never,
        result: Promise.resolve({ status: 'failed' as const, errorCode: 'navigation_failed' })
      }))
    })

    await expect(
      navigateRuntimeBrowserClientPage(authority, {
        browserPageId: 'page-stable',
        placement: clientPlacement(),
        url: 'https://remote.internal/'
      })
    ).rejects.toThrow('navigation_failed')
    expect(authority.createClientPage).not.toHaveBeenCalled()
  })

  it('retires a client page only after its exact close proof', async () => {
    const placement = clientPlacement()
    const retirement = { browserPageId: 'page-stable', placement }
    const authority = createAuthority({
      issueClientPageCommand: vi.fn(() => ({
        event: {} as never,
        result: Promise.resolve({ status: 'completed' as const })
      })),
      requireClientPage: vi.fn(() => placement),
      beginPageRetirement: vi.fn(() => retirement),
      completePageRetirement: vi.fn(() => true)
    })

    await expect(
      closeRuntimeBrowserClientPage(authority, {
        browserPageId: 'page-stable',
        placement
      })
    ).resolves.toBeUndefined()
    expect(authority.issueClientPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-stable' }),
      {
        type: 'closePage',
        targetAuthority: expect.objectContaining({ pageHostGeneration: 9 })
      }
    )
    expect(authority.completePageRetirement).toHaveBeenCalledWith(retirement)
  })

  it('retires the canonical placement when runtime publication cloned its proof', async () => {
    const placements = new BrowserHostPagePlacementRegistry({
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a'
    })
    const canonical = placements.placeClientPage('page-stable', {
      browserHostClientId: 'host-a',
      browserHostGeneration: 3
    })
    const authority = {
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      createClientPage: vi.fn(),
      issueClientPageCommand: vi.fn(() => ({
        event: {} as never,
        result: Promise.resolve({ status: 'completed' as const })
      })),
      requireClientPage: placements.requireClientPage.bind(placements),
      beginPageRetirement: placements.beginPageRetirement.bind(placements),
      completePageRetirement: placements.completePageRetirement.bind(placements)
    }

    await expect(
      closeRuntimeBrowserClientPage(authority, {
        browserPageId: 'page-stable',
        placement: { ...canonical }
      })
    ).resolves.toBeUndefined()
    expect(placements.getPlacement('page-stable')).toBeUndefined()
  })

  it('does not retire a replacement after the close proof settles late', async () => {
    const placements = new BrowserHostPagePlacementRegistry({
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a'
    })
    const original = placements.placeClientPage('page-stable', {
      browserHostClientId: 'host-a',
      browserHostGeneration: 3
    })
    const closeProof = deferred<{ status: 'completed' }>()
    const authority = {
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      createClientPage: vi.fn(),
      issueClientPageCommand: vi.fn(() => ({ event: {} as never, result: closeProof.promise })),
      requireClientPage: placements.requireClientPage.bind(placements),
      beginPageRetirement: placements.beginPageRetirement.bind(placements),
      completePageRetirement: placements.completePageRetirement.bind(placements)
    }
    const closing = closeRuntimeBrowserClientPage(authority, {
      browserPageId: 'page-stable',
      placement: { ...original }
    })

    const originalRetirement = placements.beginPageRetirement('page-stable', original)
    expect(placements.completePageRetirement(originalRetirement)).toBe(true)
    const replacement = placements.placeClientPage('page-stable', {
      browserHostClientId: 'host-a',
      browserHostGeneration: 3
    })
    closeProof.resolve({ status: 'completed' })

    await expect(closing).rejects.toThrow('browser_page_placement_stale')
    expect(placements.getPlacement('page-stable')).toBe(replacement)
  })

  it('keeps client placement retryable when close fails', async () => {
    const authority = createAuthority({
      issueClientPageCommand: vi.fn(() => ({
        event: {} as never,
        result: Promise.resolve({ status: 'failed' as const, errorCode: 'close_failed' })
      }))
    })

    await expect(
      closeRuntimeBrowserClientPage(authority, {
        browserPageId: 'page-stable',
        placement: clientPlacement()
      })
    ).rejects.toThrow('close_failed')
    expect(authority.beginPageRetirement).not.toHaveBeenCalled()
  })
})

function clientPlacement(): RuntimeBrowserClientPlacement {
  return {
    kind: 'client',
    browserHostClientId: 'host-a',
    browserHostGeneration: 3,
    pageHostGeneration: 9
  }
}

function createAuthority(overrides: Partial<ClientPageAuthority>): ClientPageAuthority {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    createClientPage: vi.fn<ClientPageAuthority['createClientPage']>(),
    issueClientPageCommand: vi.fn<ClientPageAuthority['issueClientPageCommand']>(),
    requireClientPage: vi.fn<ClientPageAuthority['requireClientPage']>(),
    beginPageRetirement: vi.fn(),
    completePageRetirement: vi.fn(),
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}
