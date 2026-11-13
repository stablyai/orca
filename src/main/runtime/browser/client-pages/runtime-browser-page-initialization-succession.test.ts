import { createRecoveryPeer } from './client-page-recovery-peer-test-harness'
import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'
import {
  buildPersistedClientHostedBrowserPages,
  RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT
} from './client-hosted-browser-page-persistence'

it('a new attach owns the successor while exact prior cleanup is still joining', async () => {
  const h = createRecoveryLoop(['slow', 'fast'])
  const started = h.hold('slow')
  const first = h.attach()
  try {
    await started
    await h.published('fast')
    const retirement = h.holdRetirement('slow')
    first.disconnect()
    const next = h.attach()
    await retirement.started
    first.abort()
    await first.completion
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
    expect(h.pages.getPage('fast')?.placement.pageHostGeneration).toBeGreaterThan(0)
    h.release('slow')
    retirement.release()
    await h.published('slow')
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.authority.getClientPageExecutionHostKey('slow')).toBe('execution-host-a')
    expect(
      h.results
        .filter((result) => result.id === 'slow')
        .map((result) => [result.type, result.status])
    ).toContainEqual(['closePage', 'completed'])
    expect(h.errors).toEqual([])
    next.abort()
    await next.completion
  } finally {
    await h.close()
  }
})

it.each(['client-a', 'replacement-client'])(
  'a fully retired ledger recovers its saved continuation on %s',
  async (hostId) => {
    const h = createRecoveryLoop(['slow'])
    try {
      let current = h.attach()
      await h.published('slow')
      for (let round = 0; round < 3; round += 1) {
        h.fence()
        current.abort()
        await current.completion
        await h.restartClient()
        const started = h.hold('slow')
        current = h.attach({ inventory: [] })
        await started
        const saved = h.pages.getPage('slow')!
        expect(saved.placement.pageHostGeneration).toBeGreaterThan(0)
        h.fence()
        current.abort()
        await current.completion
        await h.restartClient()
        h.release('slow')
        current = h.attach({ hostId, inventory: [] })
        await vi.waitFor(() =>
          expect(h.authority.getPlacement('slow')).toMatchObject({
            kind: 'client',
            browserHostClientId: hostId
          })
        )
        expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
        expect(h.executor.snapshotPageInventory()).toHaveLength(1)
        expect(h.authority.getClientPageExecutionHostKey('slow')).toBe('execution-host-a')
      }
      await retireRuntimeBrowserClientPage(
        {
          getBrowserHostLeaseRegistry: () => h.authority,
          notifyHeadlessBrowserSessionTabsChanged: (id) =>
            h.hostRuntime.notifyMobileSessionTabsChanged(id),
          getRuntimeBrowserPageRegistry: () => h.pages,
          resolveBrowserWorkspace: async () => ({ id: 'workspace' })
        },
        h.pages.getPage('slow')!
      )
      expect(h.executor.snapshotPageInventory()).toEqual([])
      expect(buildPersistedClientHostedBrowserPages(h.pages.listPages(), 100)).toEqual([])
      current.abort()
      await current.completion
      expect(h.errors).toEqual([])
    } finally {
      await h.close()
    }
  }
)

it('full retirement preserves another live scope successor and an unrelated host', async () => {
  const h = createRecoveryLoop(['slow'])
  const successor = createRecoveryPeer(h.hostRuntime, 'successor-host')
  const unrelated = createRecoveryPeer(h.hostRuntime, 'unrelated-host', 'device-b')
  try {
    h.pages.publishClientPage({
      browserPageId: 'unrelated',
      workspaceId: 'repo-1::/tmp/worktree-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'old-key',
      placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
      pairedDeviceId: 'device-b',
      url: 'https://example.internal/unrelated',
      loading: false,
      active: false
    })
    unrelated.attach()
    await h.published('unrelated')
    const unrelatedPlacement = h.pages.getPage('unrelated')!.placement
    const unrelatedCommands = unrelated.commands.length
    const navigating = h.hold('slow')
    const first = h.attach()
    await navigating
    const retirement = h.holdRetirement('slow')
    const successorNavigation = successor.hold('slow')
    successor.attach()
    await retirement.started
    h.fence()
    await successorNavigation
    first.abort()
    await first.completion
    successor.release('slow')
    await h.published('slow')
    expect(h.pages.getPage('slow')?.placement.browserHostClientId).toBe('successor-host')
    expect(h.pages.getPage('unrelated')?.placement).toEqual(unrelatedPlacement)
    expect(unrelated.commands).toHaveLength(unrelatedCommands)
    expect(unrelated.executor.snapshotPageInventory()).toHaveLength(1)
    retirement.release()
    h.release('slow')
    await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
    expect(h.pages.getPage('slow')?.placement.browserHostClientId).toBe('successor-host')
    expect(successor.executor.snapshotPageInventory()).toHaveLength(1)
    expect(successor.errors).toEqual([])
    expect(unrelated.errors).toEqual([])
  } finally {
    h.release('slow')
    await h.close()
    await successor.close()
    await unrelated.close()
  }
})

async function retirePositiveContinuation(h: ReturnType<typeof createRecoveryLoop>) {
  let current = h.attach()
  await h.published('slow')
  h.fence()
  current.abort()
  await current.completion
  await h.restartClient()
  const started = h.hold('slow')
  current = h.attach({ inventory: [] })
  await started
  const saved = h.pages.getPage('slow')!
  expect(saved.placement.pageHostGeneration).toBeGreaterThan(0)
  h.fence()
  current.abort()
  await current.completion
  await h.restartClient()
  h.release('slow')
  return saved
}

it('preserves a positive rotated-client continuation through legacy capacity failure and consumes it only on replacement', async () => {
  const h = createRecoveryLoop(['slow'])
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const saved = await retirePositiveContinuation(h)
    const placed = Array.from({ length: 256 }, (_, i) => h.authority.placeServerPage(`full-${i}`))
    const replaced = vi.spyOn(h.pages, 'replaceClientPagePlacement')
    const failed = h.attach({ hostId: 'client-b', modern: false, inventory: [] })
    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        '[browser-host-lease] client page recovery failed:',
        expect.objectContaining({ browserPageId: 'slow' })
      )
    )
    expect(h.pages.getPage('slow')?.placement).toEqual(saved.placement)
    expect(
      h.authority.clientPageInitializations.canContinue(
        'slow',
        saved.placement,
        h.authority.select('client-b')
      )
    ).toBe(true)
    const last = placed[255]
    h.authority.completePageRetirement(h.authority.beginPageRetirement('full-255', last))
    failed.abort()
    await failed.completion
    const legacy = h.attach({ modern: false, inventory: [] })
    await vi.waitFor(() =>
      expect(h.pages.getPage('slow')?.placement.browserHostClientId).toBe('client-b')
    )
    const legacyPlacement = h.pages.getPage('slow')!.placement
    expect(replaced).toHaveBeenCalledTimes(1)
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(
      h.authority.claimLegacyClientPageRecovery(h.authority.select('client-b'), {
        browserPageId: 'slow',
        browserProfileId: 'profile-a',
        workspaceId: saved.workspaceId,
        expected: saved.placement,
        isCurrent: () => false
      })
    ).toBeUndefined()
    legacy.abort()
    await legacy.completion
    await h.restartClient()
    const modern = h.attach({ inventory: [] })
    await vi.waitFor(() => {
      const live = h.authority.getPlacement('slow')
      expect(live?.kind === 'client' ? live.pageHostGeneration : undefined).toBeGreaterThan(0)
      expect(live).not.toEqual(legacyPlacement)
      expect(h.pages.getPage('slow')?.placement).toEqual(live)
    })
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.executor.snapshotPageInventory()).toHaveLength(1)
    modern.abort()
    await modern.completion
  } finally {
    warning.mockRestore()
    await h.close()
  }
})

it('keeps a timed-out legacy replacement in exact cleanup before retrying its original positive row', async () => {
  const h = createRecoveryLoop(['slow'])
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const result = Promise.withResolvers<void>()
  const issued = Promise.withResolvers<void>()
  try {
    const saved = await retirePositiveContinuation(h)
    const create = h.authority.createClientPage.bind(h.authority)
    const bounded = vi
      .spyOn(h.authority, 'createClientPage')
      .mockImplementation((input) => create({ ...input, timeoutMs: 20 }))
    h.hooks.beforeResult = async (event) => {
      if (event.command.type === 'createPage' && event.browserPageId === 'slow') {
        issued.resolve()
        await result.promise
      }
    }
    h.native.renderer.retirePage.mockRejectedValueOnce(new Error('cleanup-reply-lost'))
    h.attach({ hostId: 'client-b', modern: false, inventory: [] })
    await issued.promise
    await vi.waitFor(() =>
      expect(h.results).toContainEqual({ id: 'slow', type: 'closePage', status: 'failed' })
    )
    expect(h.pages.getPage('slow')?.placement).toEqual(saved.placement)
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      { browserPageId: 'slow', state: 'outcomeUnknown' }
    ])
    // Ordinary duplicate is still rejected by the actual asynchronous create owner.
    await expect(
      h.authority.createClientPage({
        browserPageId: 'slow',
        browserHostClientId: 'client-b',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-a',
        executionHostKey: 'execution-host-a'
      })
    ).rejects.toThrow('browser_page_replacement_requires_retirement')
    bounded.mockRestore()
    h.hooks.beforeResult = undefined
    result.resolve()
    h.attach({ inventory: h.executor.snapshotPageInventory(), modern: false })
    await vi.waitFor(() =>
      expect(
        h.authority.clientPageInitializations.canContinue(
          'slow',
          saved.placement,
          h.authority.select('client-b')
        )
      ).toBe(true)
    )
    h.attach({ inventory: [], modern: false })
    await vi.waitFor(() =>
      expect(h.pages.getPage('slow')?.placement.browserHostClientId).toBe('client-b')
    )
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.executor.snapshotPageInventory()).toHaveLength(1)
  } finally {
    result.resolve()
    warning.mockRestore()
    await h.close()
  }
})

it.each(['close', 'newer'] as const)(
  'rejects a late legacy result after %s wins the logical row',
  async (winner) => {
    const h = createRecoveryLoop(['slow'])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = Promise.withResolvers<void>()
    const issued = Promise.withResolvers<void>()
    try {
      const saved = await retirePositiveContinuation(h)
      const createsBefore = h.results.filter(
        (r) => r.id === 'slow' && r.type === 'createPage'
      ).length
      h.hooks.beforeResult = async (event) => {
        if (event.command.type === 'createPage') {
          issued.resolve()
        }
        await result.promise
      }
      h.attach({ hostId: 'client-b', modern: false, inventory: [] })
      await issued.promise
      const newerPlacement = {
        ...saved.placement,
        browserHostClientId: 'newer-client',
        pageHostGeneration: saved.placement.pageHostGeneration + 1
      }
      if (winner === 'close') {
        await retireRuntimeBrowserClientPage(
          {
            getBrowserHostLeaseRegistry: () => h.authority,
            getRuntimeBrowserPageRegistry: () => h.pages,
            resolveBrowserWorkspace: async () => ({ id: saved.workspaceId }),
            notifyHeadlessBrowserSessionTabsChanged: (id) =>
              h.hostRuntime.notifyMobileSessionTabsChanged(id)
          },
          h.pages.getPage('slow')!
        )
        expect(h.pages.getPage('slow')).toBeUndefined()
        await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
      } else {
        h.pages.replaceClientPagePlacement('slow', saved.placement, newerPlacement, 'newer-key')
        h.pages.updatePage('slow', newerPlacement, { url: 'https://example.internal/new-owner' })
      }
      expect(() => h.authority.clientPageInitializations.assertCreationAdmission('slow')).toThrow(
        'browser_page_replacement_requires_retirement'
      )
      h.hooks.beforeResult = undefined
      result.resolve()
      await vi.waitFor(() =>
        expect(h.results).toContainEqual({ id: 'slow', type: 'closePage', status: 'completed' })
      )
      await vi.waitFor(() =>
        expect(() =>
          h.authority.clientPageInitializations.assertCreationAdmission('slow')
        ).not.toThrow()
      )
      await vi.waitFor(() =>
        expect(h.results.filter((r) => r.id === 'slow' && r.type === 'createPage')).toHaveLength(
          createsBefore + 1
        )
      )
      if (winner === 'newer') {
        expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/new-owner')
        expect(h.pages.getPage('slow')?.placement).toEqual(newerPlacement)
      } else {
        expect(h.pages.getPage('slow')).toBeUndefined()
      }
      expect(h.executor.snapshotPageInventory()).toEqual([])
    } finally {
      result.resolve()
      warning.mockRestore()
      await h.close()
    }
  }
)

it('serves a newer attach once after an older held cleanup fails and publishes its successor without another attach', async () => {
  const h = createRecoveryLoop(['slow'])
  const replaced = vi.spyOn(h.pages, 'replaceClientPagePlacement')
  try {
    await h.seedNative(['slow'], 'profile-a', true)
    const held = h.holdRetirement('slow')
    h.native.renderer.retirePage.mockRejectedValueOnce(new Error('old-attach-reply-lost'))
    const first = h.attach()
    await held.started
    const second = h.attach()
    held.release()
    await h.published('slow')
    expect(h.results.filter((r) => r.id === 'slow' && r.type === 'closePage')).toEqual(
      expect.arrayContaining([
        { id: 'slow', type: 'closePage', status: 'failed' },
        { id: 'slow', type: 'closePage', status: 'completed' }
      ])
    )
    expect(
      new Set(
        h.commands
          .filter((c) => c.browserPageId === 'slow' && c.command.type === 'closePage')
          .map((c) => c.commandId)
      ).size
    ).toBe(2)
    expect(h.native.renderer.retirePage).toHaveBeenCalledTimes(2)
    expect(
      h.commands.filter((c) => c.browserPageId === 'slow' && c.command.type === 'createPage')
    ).toHaveLength(1)
    expect(replaced).toHaveBeenCalledTimes(1)
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.errors).toEqual([])
    first.abort()
    second.abort()
    await Promise.all([first.completion, second.completion])
  } finally {
    await h.close()
  }
})

it('unlinks a closed terminal page from the surviving scope before old authority retirement publishes completion', async () => {
  const h = createRecoveryLoop(['slow'])
  const successor = createRecoveryPeer(h.hostRuntime, 'successor-host')
  try {
    const started = h.hold('slow')
    const first = h.attach()
    await started
    const retirement = h.holdRetirement('slow')
    successor.attach()
    await retirement.started
    await retireRuntimeBrowserClientPage(
      {
        getBrowserHostLeaseRegistry: () => h.authority,
        getRuntimeBrowserPageRegistry: () => h.pages,
        notifyHeadlessBrowserSessionTabsChanged: (id) =>
          h.hostRuntime.notifyMobileSessionTabsChanged(id),
        resolveBrowserWorkspace: async () => ({ id: 'repo-1::/tmp/worktree-a' })
      },
      h.pages.getPage('slow')!
    )
    expect(h.pages.getPage('slow')).toBeUndefined()
    h.fence()
    first.abort()
    await first.completion
    await vi.waitFor(() => expect(h.snapshots.some((s) => s.reconciled)).toBe(true))
    expect(
      h.hostRuntime.snapshotForClient('repo-1::/tmp/worktree-a', 'device-a')
        .clientHostedPagesUnreconciled
    ).toBeUndefined()
    retirement.release()
    h.release('slow')
    await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
    expect(successor.executor.snapshotPageInventory()).toEqual([])
    expect(h.pages.getPage('slow')).toBeUndefined()
  } finally {
    await successor.close()
    await h.close()
  }
})
