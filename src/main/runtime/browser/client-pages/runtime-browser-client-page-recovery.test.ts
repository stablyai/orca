import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
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
  it('does not apply an attach inventory to a replacement placed after capture', async () => {
    const { authority, commands, notifyWorkspace, pages, placements } = harness()
    const pagePlacementsAtAttach = new Map([['page-a', oldPlacement]])
    pages.replaceClientPagePlacement('page-a', oldPlacement, newPlacement)
    placements.set('page-a', newPlacement)
    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace,
      pagePlacementsAtAttach
    })
    expect(authority.getPlacement('page-a')).toEqual(newPlacement)
    expect(pages.getPage('page-a')?.placement).toEqual(newPlacement)
    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(commands).toEqual([])
    expect(notifyWorkspace).not.toHaveBeenCalled()
  })

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
