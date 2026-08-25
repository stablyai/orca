import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { recoverUnavailableRuntimeBrowserClientPages } from './runtime-browser-client-page-recovery'

const oldPlacement = Object.freeze({
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 4,
  pageHostGeneration: 7
})
const newPlacement = Object.freeze({ ...oldPlacement, pageHostGeneration: 8 })

describe('runtime browser client page recovery', () => {
  it('closes an unavailable generation before creating and navigating the next generation', async () => {
    const { authority, commands, notifyWorkspace, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([inventory('outcomeUnknown')]),
      authority,
      pages,
      notifyWorkspace
    })

    expect(commands).toEqual([
      { browserPageId: 'page-a', type: 'closePage', pageHostGeneration: 7 },
      { browserPageId: 'page-a', type: 'navigate', pageHostGeneration: 8 }
    ])
    expect(authority.createClientPage).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-a',
        browserHostClientId: 'host-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:1'
      })
    )
    expect(pages.getPage('page-a')).toMatchObject({
      placement: newPlacement,
      url: 'https://client-latest.internal/',
      loading: false
    })
    expect(notifyWorkspace).toHaveBeenCalledOnce()
  })

  it('retains an exact active generation without commands or metadata churn', async () => {
    const { authority, commands, notifyWorkspace, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([inventory('active')]),
      authority,
      pages,
      notifyWorkspace
    })

    expect(commands).toEqual([])
    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(pages.getPage('page-a')?.placement).toEqual(oldPlacement)
    expect(notifyWorkspace).not.toHaveBeenCalled()
  })

  it('treats negotiated missing inventory as absence and still allocates a fresh generation', async () => {
    const { authority, commands, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(commands).toEqual([{ browserPageId: 'page-a', type: 'navigate', pageHostGeneration: 8 }])
    expect(pages.getPage('page-a')?.placement).toEqual(newPlacement)
  })

  it('degrades a failed navigation to that page instead of failing the attach', async () => {
    const { authority, notifyWorkspace, pages } = harness({
      pageIds: ['page-a', 'page-b'],
      navigateFailures: ['page-a']
    })
    const releaseUnrecoverablePage = vi.fn()

    await expect(
      recoverUnavailableRuntimeBrowserClientPages({
        lease: lease([]),
        authority,
        pages,
        notifyWorkspace,
        releaseUnrecoverablePage
      })
    ).resolves.toBeUndefined()

    expect(pages.getPage('page-b')).toMatchObject({
      placement: { pageHostGeneration: 10 },
      loading: false
    })
    // The page kept a live placement, so it stays listed and a later attach can retry it.
    expect(pages.getPage('page-a')?.placement).toMatchObject({ pageHostGeneration: 8 })
    // A refused navigation is never recorded as an arrival: the page stays loading, not settled.
    expect(pages.getPage('page-a')).toMatchObject({ loading: true })
    expect(releaseUnrecoverablePage).not.toHaveBeenCalled()
  })

  it('releases a page whose recovery left it without any placement', async () => {
    const { authority, notifyWorkspace, pages } = harness({
      pageIds: ['page-a', 'page-b'],
      creationFailures: ['page-a']
    })
    const releaseUnrecoverablePage = vi.fn()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace,
      releaseUnrecoverablePage
    })

    expect(releaseUnrecoverablePage).toHaveBeenCalledOnce()
    expect(releaseUnrecoverablePage).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-a' })
    )
    expect(pages.getPage('page-b')).toMatchObject({ placement: { pageHostGeneration: 10 } })
  })

  it('stops recovering pages once the attach is aborted', async () => {
    const abort = new AbortController()
    const { authority, pages } = harness({
      pageIds: ['page-a', 'page-b', 'page-c', 'page-d', 'page-e'],
      onCommand: () => abort.abort()
    })

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace: vi.fn(),
      signal: abort.signal
    })

    expect(authority.createClientPage).toHaveBeenCalledTimes(4)
    expect(pages.getPage('page-e')?.placement).toMatchObject({ pageHostGeneration: 15 })
  })

  it.each([
    ['pageHostGeneration', { pageHostGeneration: 99 }],
    ['executionHostKey', { executionHostKey: 'native:runtime-a:2' }],
    ['authorityEpoch', { authorityEpoch: 'epoch-b' }],
    ['authorityRuntimeId', { authorityRuntimeId: 'runtime-b' }],
    ['browserProfileId', { browserProfileId: 'profile-b' }],
    ['browserHostClientId', { browserHostClientId: 'host-b' }],
    ['browserHostGeneration', { browserHostGeneration: 9 }]
  ])(
    'never trusts an active inventory entry that disagrees on %s',
    async (_field, disagreement) => {
      const { authority, notifyWorkspace, pages, placements } = harness()
      // The runtime already re-placed the page, so only an exact-active entry may skip recovery.
      placements.set('page-a', newPlacement)

      await recoverUnavailableRuntimeBrowserClientPages({
        lease: lease([inventory('active', disagreement)]),
        authority,
        pages,
        notifyWorkspace
      })

      expect(pages.getPage('page-a')?.placement).toEqual(newPlacement)
      expect(notifyWorkspace).toHaveBeenCalledOnce()
    }
  )

  it('refuses to close a page whose inventory reports another page host generation', async () => {
    const { authority, commands, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([inventory('outcomeUnknown', { pageHostGeneration: 99 })]),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(commands).toEqual([])
    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(pages.getPage('page-a')?.placement).toEqual(oldPlacement)
  })

  it('leaves pages placed on another host or another host generation untouched', async () => {
    const { authority, pages } = harness()
    publishPage(pages, 'page-other-host', { ...oldPlacement, browserHostClientId: 'host-b' })
    publishPage(pages, 'page-other-generation', { ...oldPlacement, browserHostGeneration: 9 })

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(authority.createClientPage).toHaveBeenCalledOnce()
    expect(authority.createClientPage).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-a' })
    )
    expect(pages.getPage('page-other-host')?.placement).toMatchObject({
      browserHostClientId: 'host-b'
    })
    expect(pages.getPage('page-other-generation')?.placement).toMatchObject({
      browserHostGeneration: 9
    })
  })

  it('recovers the pages adoption did not take while leaving the ones it did', async () => {
    const { authority, pages } = harness({ pageIds: ['page-a', 'page-b'] })

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace: vi.fn(),
      adoptedPageIds: new Set(['page-a'])
    })

    expect(authority.createClientPage).toHaveBeenCalledOnce()
    expect(authority.createClientPage).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-b' })
    )
    expect(pages.getPage('page-a')?.placement).toMatchObject({ pageHostGeneration: 7 })
    expect(pages.getPage('page-b')?.placement).toMatchObject({ pageHostGeneration: 10 })
  })

  it('recovers a page retained from a host generation that quit', async () => {
    const { authority, commands, notifyWorkspace, pages, placements } = harness({
      url: 'https://retained.internal/'
    })
    // The fence released the placement but kept the record naming the generation that placed it.
    placements.set('page-a', undefined)

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: { ...lease([]), browserHostGeneration: 5 },
      authority,
      pages,
      notifyWorkspace
    })

    // Nothing to close: the desktop that owned the old generation is gone.
    expect(commands).toEqual([{ browserPageId: 'page-a', type: 'navigate', pageHostGeneration: 8 }])
    expect(authority.createClientPage).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-a', browserHostClientId: 'host-a' })
    )
    expect(pages.getPage('page-a')).toMatchObject({
      placement: newPlacement,
      url: 'https://retained.internal/',
      loading: false
    })
    expect(notifyWorkspace).toHaveBeenCalledOnce()
  })

  it('refuses to adopt a placement another host now owns', async () => {
    const { authority, notifyWorkspace, pages, placements } = harness()
    placements.set('page-a', Object.freeze({ ...newPlacement, browserHostClientId: 'host-b' }))

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace
    })

    expect(pages.getPage('page-a')?.placement).toEqual(oldPlacement)
    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(notifyWorkspace).not.toHaveBeenCalled()
  })

  it('does not recreate a page whose retirement lost to a concurrent placement change', async () => {
    const { authority, pages } = harness()
    authority.completePageRetirement.mockReturnValue(false)

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(pages.getPage('page-a')?.placement).toEqual(oldPlacement)
  })

  it('keeps a page placed when its close command fails', async () => {
    const { authority, commands, pages } = harness({ closeFailures: ['page-a'] })

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([inventory('outcomeUnknown')]),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(commands).toEqual([
      { browserPageId: 'page-a', type: 'closePage', pageHostGeneration: 7 }
    ])
    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(pages.getPage('page-a')?.placement).toEqual(oldPlacement)
  })

  it('abandons a close whose placement changed identity while the command ran', async () => {
    let replacePlacement = (): void => {}
    const { authority, pages, placements } = harness({ onCommand: () => replacePlacement() })
    replacePlacement = () => {
      placements.set('page-a', Object.freeze({ ...oldPlacement, pageHostGeneration: 11 }))
    }

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([inventory('outcomeUnknown')]),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(authority.beginPageRetirement).not.toHaveBeenCalled()
    expect(authority.createClientPage).not.toHaveBeenCalled()
  })

  it('does nothing without a negotiated page inventory protocol', async () => {
    const { authority, commands, pages } = harness()
    const { pageInventoryProtocolVersion: _unnegotiated, ...unnegotiated } = lease([])

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: unnegotiated,
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(commands).toEqual([])
    expect(authority.createClientPage).not.toHaveBeenCalled()
  })

  it('recovers an about:blank page without issuing a navigation', async () => {
    const { authority, commands, pages } = harness({ url: 'about:blank' })

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(commands).toEqual([])
    expect(authority.createClientPage).toHaveBeenCalledOnce()
    expect(pages.getPage('page-a')).toMatchObject({ placement: newPlacement, loading: false })
  })
})

function harness(
  options: {
    pageIds?: readonly string[]
    navigateFailures?: readonly string[]
    closeFailures?: readonly string[]
    creationFailures?: readonly string[]
    url?: string
    onCommand?: () => void
  } = {}
) {
  const pageIds = options.pageIds ?? ['page-a']
  const pages = new RuntimeBrowserPageRegistry()
  const placements = new Map<string, RuntimeBrowserClientPlacement | undefined>()
  pageIds.forEach((browserPageId, index) => {
    const placement = Object.freeze({ ...oldPlacement, pageHostGeneration: 7 + index * 2 })
    placements.set(browserPageId, placement)
    publishPage(pages, browserPageId, placement, {
      url: options.url ?? 'https://server-known.internal/',
      active: index === 0
    })
  })
  const commands: { browserPageId: string; type: string; pageHostGeneration: number }[] = []
  const authority = {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    getPlacement: vi.fn((browserPageId: string) => placements.get(browserPageId)),
    beginPageRetirement: vi.fn((browserPageId: string, expected: RuntimeBrowserClientPlacement) => {
      if (expected !== placements.get(browserPageId)) {
        throw new Error('browser_page_placement_stale')
      }
      return { browserPageId, placement: expected }
    }),
    completePageRetirement: vi.fn((retirement: { browserPageId: string }) => {
      placements.set(retirement.browserPageId, undefined)
      return true
    }),
    createClientPage: vi.fn(async (input: { browserPageId: string }) => {
      if (options.creationFailures?.includes(input.browserPageId)) {
        throw new Error('browser_host_page_creation_timeout')
      }
      const index = pageIds.indexOf(input.browserPageId)
      const placement = Object.freeze({ ...newPlacement, pageHostGeneration: 8 + index * 2 })
      placements.set(input.browserPageId, placement)
      return placement
    }),
    issueClientPageCommand: vi.fn(
      (input: { browserPageId: string; pageHostGeneration: number }, command: { type: string }) => {
        commands.push({
          browserPageId: input.browserPageId,
          type: command.type,
          pageHostGeneration: input.pageHostGeneration
        })
        options.onCommand?.()
        const failed =
          (command.type === 'navigate' &&
            options.navigateFailures?.includes(input.browserPageId)) ||
          (command.type === 'closePage' && options.closeFailures?.includes(input.browserPageId))
        return {
          event: {},
          result: Promise.resolve(
            failed
              ? { status: 'failed' as const, errorCode: 'browser_client_page_navigation_failed' }
              : { status: 'completed' as const }
          )
        }
      }
    )
  }
  return { authority, commands, notifyWorkspace: vi.fn(), pages, placements }
}

function publishPage(
  pages: RuntimeBrowserPageRegistry,
  browserPageId: string,
  placement: RuntimeBrowserClientPlacement,
  overrides: { url?: string; active?: boolean } = {}
): void {
  pages.publishClientPage({
    browserPageId,
    workspaceId: 'workspace-a',
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement,
    url: overrides.url ?? 'https://server-known.internal/',
    loading: true,
    active: overrides.active ?? false
  })
}

function lease(pageInventory: ReturnType<typeof inventory>[]) {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'host-a',
    browserHostGeneration: 4,
    pairedDeviceId: 'device-a',
    pageCommandProtocolVersion: 1 as const,
    pageInventoryProtocolVersion: 1 as const,
    pageReconciliationProtocolVersion: 1 as const,
    pageInventory
  }
}

function inventory(
  state: 'active' | 'outcomeUnknown',
  disagreement: Record<string, string | number> = {}
) {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'host-a',
    browserHostGeneration: 4,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    state,
    currentUrl: 'https://client-latest.internal/',
    ...disagreement
  } as ReturnType<typeof exactInventory>
}

function exactInventory() {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'host-a',
    browserHostGeneration: 4,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    state: 'active' as 'active' | 'outcomeUnknown',
    currentUrl: 'https://client-latest.internal/'
  }
}
