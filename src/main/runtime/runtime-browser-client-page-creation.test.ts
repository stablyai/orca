import { describe, expect, it, vi } from 'vitest'
import { BrowserHostPagePlacementRegistry } from './browser-host/browser-host-page-placement'

import { closeRuntimeBrowserClientPage } from './runtime-browser-client-page-creation'

describe('runtime browser client page creation', () => {
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
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}
