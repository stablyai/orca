import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'

const WORKSPACE = 'repo-1::/tmp/worktree-a'

it.each([false, true])(
  'publishes cleared current holds to stale workspaces after cleanup=%s',
  async (failCommit) => {
    const h = createRecoveryLoop([])
    const frames: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = h.hostRuntime.onMobileSessionTabsChanged(
      (frame) => frames.push(frame),
      'device-a',
      'mobile'
    )
    const staleWorkspace = 'repo-1::/tmp/stale'
    try {
      const stale = h.pages.publishClientPage({
        browserPageId: 'stale',
        workspaceId: staleWorkspace,
        browserProfileId: 'profile-a',
        pairedDeviceId: 'device-a',
        executionHostKey: 'old-key',
        placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
        url: 'https://example.internal/stale',
        loading: false,
        active: false
      })
      h.hostRuntime.notifyMobileSessionTabsChanged(staleWorkspace)
      h.pages.retirePage('stale', stale.placement)
      await h.seedNative(['slow'])
      const started = h.hold('slow')
      h.hooks.failCommit = failCommit
      const first = h.attach()
      if (!failCommit) {
        await started
        expect(
          frames.findLast((frame) => frame.worktree === WORKSPACE)?.clientHostedPagesUnreconciled
        ).toBe(true)
        const retirement = h.holdRetirement('slow')
        const next = h.attach()
        await retirement.started
        first.abort()
        await first.completion
        expect(
          frames.findLast((frame) => frame.worktree === WORKSPACE)?.clientHostedPagesUnreconciled
        ).toBe(true)
        retirement.release()
        h.release('slow')
        await h.published('slow')
        await vi.waitFor(() =>
          expect(
            h.snapshots.some((snapshot) => snapshot.reconciled),
            JSON.stringify({ snapshots: h.snapshots, errors: h.errors, results: h.results })
          ).toBe(true)
        )
        await vi.waitFor(() =>
          expect(
            frames.findLast((frame) => frame.worktree === staleWorkspace)
              ?.clientHostedPagesUnreconciled
          ).toBeUndefined()
        )
        next.abort()
        await next.completion
      } else {
        await vi.waitFor(() =>
          expect(h.snapshots.some((snapshot) => snapshot.reconciled)).toBe(true)
        )
        expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
        expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
        expect(
          frames.findLast((frame) => frame.worktree === WORKSPACE)?.clientHostedPagesUnreconciled
        ).toBeUndefined()
        expect(
          frames.findLast((frame) => frame.worktree === staleWorkspace)
            ?.clientHostedPagesUnreconciled
        ).toBeUndefined()
        first.abort()
        await first.completion
      }
    } finally {
      unsubscribe()
      await h.close()
    }
  }
)

it('keeps a modern active exact guest when actual inventory trimming omits its address', async () => {
  const h = createRecoveryLoop(['page'])
  try {
    const started = h.hold('page')
    const first = h.attach()
    await started
    h.release(
      'page',
      `https://example.internal/${'x'.repeat(BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH)}`
    )
    await h.published('page')
    const page = h.pages.getPage('page')!
    expect(h.executor.snapshotPageInventory()[0]).toMatchObject({ state: 'active' })
    expect(h.executor.snapshotPageInventory()[0]?.currentUrl).toBeUndefined()
    h.commands.length = 0
    const next = h.attach()
    await first.completion
    expect(h.commands).toEqual([])
    expect(h.executor.hasPage('page', page.placement.pageHostGeneration)).toBe(true)
    next.abort()
    await next.completion
  } finally {
    await h.close()
  }
})

it('retires a late legacy replacement after its captured logical row closes', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    await h.seedNative(['slow'])
    const started = h.hold('slow')
    const attached = h.attach({ modern: false })
    await started
    const page = h.pages.getPage('slow')!
    h.pages.retirePage('slow', page.placement)
    h.release('slow')
    await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
    expect(h.authority.getPlacement('slow')).toBeUndefined()
    expect(h.authority.getClientPageExecutionHostKey('slow')).toBeUndefined()
    expect(h.commands.map((event) => event.command.type)).toContain('restorePage')
    expect(
      h.commands.some(
        (event) => event.command.type === 'createPage' && event.command.initialUrl !== undefined
      )
    ).toBe(false)
    attached.abort()
    await attached.completion
  } finally {
    await h.close()
  }
})

it.each([false, true])(
  'clears a known saved predecessor hold after cleanup=%s',
  async (failCommit) => {
    const h = createRecoveryLoop(['slow'])
    const frames: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = h.hostRuntime.onMobileSessionTabsChanged(
      (frame) => frames.push(frame),
      'device-a',
      'mobile'
    )
    try {
      await h.seedNative(['slow'])
      expect(
        h.hostRuntime.snapshotForClient(WORKSPACE, 'device-a').clientHostedPagesUnreconciled
      ).toBe(true)
      const started = h.hold('slow')
      h.hooks.failCommit = failCommit
      const attached = h.attach()
      if (!failCommit) {
        await started
        h.release('slow')
        await h.published('slow')
      }
      await vi.waitFor(() =>
        expect(
          frames.some(
            (frame) =>
              frame.worktree === WORKSPACE && frame.clientHostedPagesUnreconciled === undefined
          )
        ).toBe(true)
      )
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
      if (failCommit) {
        expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
        expect(h.executor.snapshotPageInventory()).toEqual([])
      }
      attached.abort()
      await attached.completion
    } finally {
      unsubscribe()
      await h.close()
    }
  }
)

it('legacy late cleanup cannot retire a newer native and logical page with the same id', async () => {
  const h = createRecoveryLoop(['slow'])
  const ready = Promise.withResolvers<void>()
  const deliver = Promise.withResolvers<void>()
  h.hooks.beforeResult = async (event) => {
    if (event.command.type === 'restorePage') {
      ready.resolve()
      await deliver.promise
    }
  }
  try {
    await h.seedNative(['slow'])
    const attached = h.attach({ modern: false })
    await ready.promise
    const old = h.executor.snapshotPageInventory()[0]!
    expect(await h.executor.retirePage('slow', old.pageHostGeneration)).toBe(true)
    const replacement = {
      type: 'command' as const,
      authorityRuntimeId: 'runtime-newer',
      authorityEpoch: 'epoch-newer',
      browserHostClientId: 'newer-client',
      browserHostGeneration: 9,
      browserPageId: 'slow',
      pageHostGeneration: 999,
      pageCommandProtocolVersion: 1 as const,
      commandId: 'newer-create',
      commandSequence: 1,
      command: {
        type: 'createPage' as const,
        browserProfileId: 'profile-a',
        executionHostKey: 'execution-host-a',
        workspaceId: WORKSPACE
      }
    }
    expect(await h.executor.handle(replacement, new AbortController().signal)).toEqual({
      status: 'completed'
    })
    const prior = h.pages.getPage('slow')!
    h.pages.retirePage('slow', prior.placement)
    const newer = h.pages.publishClientPage({
      ...prior,
      placement: {
        kind: 'client',
        browserHostClientId: 'newer-client',
        browserHostGeneration: 9,
        pageHostGeneration: 999
      },
      url: 'https://example.internal/newer'
    })
    deliver.resolve()
    await vi.waitFor(() =>
      expect(
        h.results.some((result) => result.type === 'closePage' && result.status === 'failed')
      ).toBe(true)
    )
    expect(h.pages.getPage('slow')).toBe(newer)
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      { authorityRuntimeId: 'runtime-newer', pageHostGeneration: 999 }
    ])
    attached.abort()
    await attached.completion
  } finally {
    deliver.resolve()
    await h.close()
  }
})

it.each(['cleanup-failure', 'full-fence'] as const)(
  'legacy late completion preserves the newer saved row after %s',
  async (phase) => {
    const h = createRecoveryLoop(['slow'])
    try {
      await h.seedNative(['slow'])
      const started = h.hold('slow')
      const attached = h.attach({ modern: false })
      await started
      h.results.length = 0
      const prior = h.pages.getPage('slow')!
      h.pages.retirePage('slow', prior.placement)
      const newer = h.pages.publishClientPage({
        ...prior,
        placement: {
          kind: 'client',
          browserHostClientId: 'newer-client',
          browserHostGeneration: 9,
          pageHostGeneration: 999
        },
        url: 'https://example.internal/newer'
      })
      if (phase === 'cleanup-failure') {
        h.native.renderer.retirePage.mockRejectedValueOnce(new Error('retirement-failed'))
      } else {
        h.fence()
      }
      h.release('slow')
      await vi.waitFor(() =>
        expect(
          h.results.some(
            (result) => result.type === (phase === 'cleanup-failure' ? 'closePage' : 'restorePage')
          )
        ).toBe(true)
      )
      expect(h.pages.getPage('slow')).toBe(newer)
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/newer')
      if (phase === 'cleanup-failure') {
        expect(h.results.findLast((result) => result.type === 'closePage')?.status).toBe('failed')
        expect(h.executor.snapshotPageInventory()).toHaveLength(1)
      }
      attached.abort()
      await attached.completion
    } finally {
      await h.close()
    }
  }
)
