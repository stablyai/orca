import { expect, it, vi } from 'vitest'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { browserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'

const WORKSPACE = 'repo-1::/tmp/worktree-a'
const IDS = ['slow', 'fast', 'third', 'fourth', 'fifth', 'sixth']

it('joins all six exact predecessors before retargeting their partition, without holding fast pages behind slow navigation', async () => {
  const h = createRecoveryLoop(IDS)
  const key = browserNetworkExecutionHostKey({
    kind: 'native',
    runtimeId: 'runtime-a',
    revision: 1
  })
  h.native.dependencies.retainNetworkRoute.mockImplementation(async (requested) => ({
    ...h.native.route,
    key: requested
  }))
  h.hostRuntime.resolveBrowserExecutionHostKeyForWorkspace = async () => ({
    status: 'resolved',
    executionHostKey: key
  })
  try {
    await h.seedNative(IDS)
    const predecessor = h.executor.snapshotPageInventory()
    const cleanup = h.holdRetirement('sixth')
    const started = h.hold('slow')
    h.native.dependencies.routeSessions.preparePage.mockImplementation(async () => {
      // A shared-session proxy may change only after every old page's native join.
      expect(
        h.executor.snapshotPageInventory().filter((p) => p.authorityRuntimeId === 'runtime-old')
      ).toEqual([])
      return h.native.routeSession
    })
    h.attach()
    await cleanup.started
    const lease = h.authority.select('client-a')
    const ordinary = h.authority.createClientPage({
      browserPageId: 'ordinary',
      browserHostClientId: 'client-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-a',
      executionHostKey: key,
      workspaceId: WORKSPACE
    })
    expect(
      (await h.hostRuntime.snapshotForClient(WORKSPACE, 'device-a')).tabs
        .filter((t) => t.type === 'browser')
        .map((t) => t.initializationState)
    ).toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'pending'])
    // No replacement may be visible while one native predecessor has not joined.
    expect(h.commands.some((c) => c.command.type === 'createPage')).toBe(false)
    cleanup.release()
    await started
    await Promise.all(IDS.slice(1).map((id) => h.published(id)))
    await ordinary
    expect(h.results.filter((r) => r.type === 'closePage' && IDS.includes(r.id))).toEqual(
      expect.arrayContaining(IDS.map((id) => ({ type: 'closePage', id, status: 'completed' })))
    )
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
    expect(
      h.authority.clientPageInitializations.status('slow', h.pages.getPage('slow')!.placement)
    ).toBe('pending')
    h.release('slow', 'https://example.internal/redirected')
    await h.published('slow')
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/redirected')
    expect(
      h.authority.clientPageInitializations.status('slow', h.pages.getPage('slow')!.placement)
    ).toBeUndefined()
    expect(
      h.executor
        .snapshotPageInventory()
        .filter((p) => IDS.includes(p.browserPageId))
        .every((p) => p.state === 'active')
    ).toBe(true)
    expect(
      h.executor
        .snapshotPageInventory()
        .some((p) => predecessor.some((old) => old.authorityRuntimeId === p.authorityRuntimeId))
    ).toBe(false)
    expect(h.errors).toEqual([])
    h.authority.requireLease(lease)
  } finally {
    await h.close()
  }
})

it('lets another profile create while an exact predecessor join is held', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    await h.seedNative(['slow'])
    const cleanup = h.holdRetirement('slow')
    h.attach()
    await cleanup.started
    const independent = await h.authority.createClientPage({
      browserPageId: 'independent',
      browserHostClientId: 'client-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-b',
      executionHostKey: 'execution-host-a',
      workspaceId: WORKSPACE
    })
    expect(independent.pageHostGeneration).toBeGreaterThan(0)
    expect(
      h.executor
        .snapshotPageInventory()
        .map((p) => p.browserPageId)
        .sort()
    ).toEqual(['independent', 'slow'])
    expect(
      h.commands.some((c) => c.browserPageId === 'slow' && c.command.type === 'createPage')
    ).toBe(false)
    cleanup.release()
    await h.published('slow')
    expect(h.errors).toEqual([])
  } finally {
    await h.close()
  }
})

it('keeps a closed queued cohort member in exact cleanup and resumes the surviving cohort on successor attach', async () => {
  const h = createRecoveryLoop(IDS)
  try {
    await h.seedNative(IDS)
    const held = IDS.slice(0, 4).map((id) => h.holdRetirement(id))
    const first = h.attach()
    await Promise.all(held.map((h) => h.started))
    const closed = h.pages.getPage('sixth')!
    await retireRuntimeBrowserClientPage(
      {
        getBrowserHostLeaseRegistry: () => h.authority,
        getRuntimeBrowserPageRegistry: () => h.pages,
        resolveBrowserWorkspace: async () => ({ id: WORKSPACE }),
        notifyHeadlessBrowserSessionTabsChanged: (id) =>
          h.hostRuntime.notifyMobileSessionTabsChanged(id)
      },
      closed
    )
    expect(h.pages.getPage('sixth')).toBeUndefined()
    expect(h.executor.snapshotPageInventory().some((p) => p.browserPageId === 'sixth')).toBe(true)
    const next = h.attach()
    first.abort()
    await first.completion
    for (const cleanup of held) {
      cleanup.release()
    }
    await Promise.all(IDS.slice(0, 5).map((id) => h.published(id)))
    await vi.waitFor(() =>
      expect(
        h.executor
          .snapshotPageInventory()
          .map((p) => p.browserPageId)
          .sort()
      ).toEqual(['fast', 'fifth', 'fourth', 'slow', 'third'])
    )
    expect(
      h.results.some((r) => r.id === 'sixth' && r.type === 'closePage' && r.status === 'completed')
    ).toBe(true)
    expect(
      h.commands.some((c) => c.browserPageId === 'sixth' && c.command.type === 'createPage')
    ).toBe(false)
    next.abort()
    await next.completion
  } finally {
    await h.close()
  }
})
