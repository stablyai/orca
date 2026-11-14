import { workspaceSessionStateSchema } from '../../../../shared/workspace-session/workspace-session-schema'
import { prepareBrowserClientPageInventoryForAttach } from '../../../browser/client-pages/lifecycle/browser-client-page-inventory'
import { BrowserClientPageMetadataTransport } from '../../../browser/client-pages/renderer/browser-client-page-metadata-transport'
import {
  buildPersistedClientHostedBrowserPages,
  rehydrateClientHostedBrowserPages
} from './client-hosted-browser-page-persistence'
import { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

const WORKSPACE = 'repo-1::/tmp/worktree-a'
type Harness = ReturnType<typeof createRecoveryLoop>
async function action(h: Harness, type: 'stop' | 'navigate', url?: string) {
  const page = h.pages.getPage('slow')!
  const responses: { ok: boolean; result?: unknown; error?: unknown }[] = []
  await h.rpc.dispatchStreaming(
    {
      id: 'action',
      authToken: 'test',
      method: 'browser.clientPage.initializationAction',
      params: {
        worktree: `id:${WORKSPACE}`,
        page: 'slow',
        expectedPlacement: page.placement,
        action: type === 'stop' ? { type } : { type, url }
      }
    },
    (text) => responses.push(JSON.parse(text)),
    h.caller()
  )
  expect(responses).toHaveLength(1)
  return responses[0]
}

it('follows the same row through commit while the workspace resolver is awaited and rejects a closed owner', async () => {
  const h = createRecoveryLoop(['slow'])
  const navigating = h.hold('slow')
  try {
    h.attach()
    await navigating
    const resolving = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<void>()
    h.hooks.beforeWorkspace = async () => {
      resolving.resolve()
      await resolved.promise
    }
    const stop = action(h, 'stop')
    await resolving.promise
    h.release('slow')
    await h.published('slow')
    resolved.resolve()
    expect(await stop).toMatchObject({ ok: true })
    expect(h.commands.findLast((c) => c.command.type === 'automation')?.command).toMatchObject({
      method: 'browser.eval',
      params: { expression: 'window.stop()' },
      agent: false
    })
    h.hooks.beforeWorkspace = undefined
    // A second held resolver cannot cross logical close and act on the removed page.
    const waiting = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    h.hooks.beforeWorkspace = async () => {
      waiting.resolve()
      await done.promise
    }
    const stale = action(h, 'navigate', 'https://example.internal/stale')
    await waiting.promise
    await retireRuntimeBrowserClientPage(
      {
        getBrowserHostLeaseRegistry: () => h.authority,
        getRuntimeBrowserPageRegistry: () => h.pages,
        notifyHeadlessBrowserSessionTabsChanged: (id) =>
          h.hostRuntime.notifyMobileSessionTabsChanged(id),
        resolveBrowserWorkspace: async () => ({ id: WORKSPACE })
      },
      h.pages.getPage('slow')!
    )
    const commands = h.commands.length
    done.resolve()
    expect((await stale).ok).toBe(false)
    expect(h.commands).toHaveLength(commands)
    expect(h.pages.getPage('slow')).toBeUndefined()
  } finally {
    await h.close()
  }
})

it('acknowledges committed Navigate without waiting for its full load', async () => {
  const h = createRecoveryLoop(['slow'])
  const started = h.hold('slow')
  const resolving = Promise.withResolvers<void>()
  const resolved = Promise.withResolvers<void>()
  try {
    h.attach()
    await started
    h.hooks.beforeWorkspace = async () => {
      resolving.resolve()
      await resolved.promise
    }
    const accepted = action(h, 'navigate', 'https://example.internal/held-full-load')
    await resolving.promise
    h.release('slow')
    await h.published('slow')
    const completedBefore = h.results.filter((r) => r.type === 'navigate').length
    const loading = h.hold('held-full-load')
    resolved.resolve()
    expect(await accepted).toMatchObject({ ok: true })
    await loading
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/held-full-load')
    expect(h.results.filter((r) => r.type === 'navigate')).toHaveLength(completedBefore)
    h.release('held-full-load')
  } finally {
    resolved.resolve()
    await h.close()
  }
})

it('rejects superseded goto promptly while its native cleanup is held, and preserves clean Stop through same-lease reconnect', async () => {
  const h = createRecoveryLoop(['slow', 'unfinished'])
  const initial = h.hold('slow')
  const unfinished = h.hold('unfinished')
  try {
    const first = h.attach()
    await Promise.all([initial, unfinished])
    expect(
      h.hostRuntime.snapshotForClient(WORKSPACE, 'device-a').clientHostedPagesUnreconciled
    ).toBe(true)
    const following = h.hold('next')
    const goto = h.hostRuntime.routeClientHostedBrowserRpc(
      'browser.goto',
      {
        page: 'slow',
        url: 'https://example.internal/next'
      },
      { kind: 'local-cli' }
    )
    const rejected = expect(goto).rejects.toThrow('initialization_cancelled')
    await following
    const cleanup = h.holdRetirement('slow')
    expect(await action(h, 'stop')).toMatchObject({ ok: true })
    await rejected
    await cleanup.started
    expect(h.executor.snapshotPageInventory().some((p) => p.browserPageId === 'slow')).toBe(true)
    const commandCount = h.commands.filter(
      (c) => c.browserPageId === 'slow' && c.command.type === 'createPage'
    ).length
    cleanup.release()
    await vi.waitFor(() =>
      expect(h.executor.snapshotPageInventory().some((p) => p.browserPageId === 'slow')).toBe(false)
    )
    const reattached = h.attach()
    first.abort()
    await first.completion
    await vi.waitFor(() => expect(h.authority.select('client-a').connectionId).toBe('connection-2'))
    expect(
      h.authority.clientPageInitializations.status('slow', h.pages.getPage('slow')!.placement)
    ).toBe('stopped')
    expect(
      h.commands.filter((c) => c.browserPageId === 'slow' && c.command.type === 'createPage')
    ).toHaveLength(commandCount)
    h.release('unfinished')
    await h.published('unfinished')
    await vi.waitFor(() => expect(h.snapshots.some((s) => s.reconciled)).toBe(true))
    expect(
      h.hostRuntime.snapshotForClient(WORKSPACE, 'device-a').clientHostedPagesUnreconciled
    ).toBeUndefined()
    expect(await action(h, 'navigate', 'about:blank')).toMatchObject({ ok: true })
    await h.published('slow')
    expect(h.pages.getPage('slow')?.url).toBe('data:text/html,')
    reattached.abort()
    await reattached.completion
  } finally {
    await h.close()
  }
})

it.each(['successor', 'operation'] as const)(
  'keeps the current UI destination across reconnect while its %s is pending',
  async (phase) => {
    const h = createRecoveryLoop(['slow'])
    const started = h.hold('slow')
    try {
      const first = h.attach()
      await started
      const cleanup = h.holdRetirement('slow')
      if (phase === 'operation') {
        expect(await action(h, 'stop')).toMatchObject({ ok: true })
        await cleanup.started
        cleanup.release()
        await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
      }
      const requested = h.hold('B')
      expect(await action(h, 'navigate', 'https://example.internal/B')).toMatchObject({ ok: true })
      await (phase === 'successor' ? cleanup.started : requested)
      const before = h.nativeLoop.initializedUrls.length
      const replacement = phase === 'operation' ? h.hold('B') : requested
      const second = h.attach()
      first.abort()
      await first.completion
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/B')
      cleanup.release()
      await replacement
      h.release('B', 'https://example.internal/B-redirect')
      await vi.waitFor(() =>
        expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/B-redirect')
      )
      expect(h.nativeLoop.initializedUrls.slice(before)).toEqual(['https://example.internal/B'])
      expect(buildPersistedClientHostedBrowserPages(h.pages.listPages(), 100)[0].url).toBe(
        'https://example.internal/B-redirect'
      )
      expect(h.errors).toEqual([])
      second.abort()
      await second.completion
    } finally {
      await h.close()
    }
  }
)

it.each(['reconnect', 'rehydrate'] as const)(
  'keeps an offline native commit after exact guest loss and %s',
  async (mode) => {
    const h = createRecoveryLoop(['slow'])
    let resumed: Harness | undefined
    try {
      const first = h.attach()
      await h.published('slow')
      first.disconnect()
      first.abort()
      await first.completion
      const inventory = h.executor.snapshotPageInventory()[0]
      const metadata = new BrowserClientPageMetadataTransport(h.executor.recordPublishedPageUrl)
      await expect(
        metadata.publish({
          ...inventory,
          revision: 1,
          url: 'https://example.internal/C',
          title: 'Committed offline',
          loading: false,
          canGoBack: true,
          canGoForward: false
        })
      ).rejects.toThrow('unavailable')
      h.nativeLoop.lose('slow')
      expect(h.executor.snapshotPageInventory()[0]).toMatchObject({
        state: 'outcomeUnknown',
        currentUrl: 'https://example.internal/C'
      })
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
      const target =
        mode === 'rehydrate'
          ? (resumed = createRecoveryLoop([], { nativeLoop: h.nativeLoop, executor: h.executor }))
          : h
      if (mode === 'rehydrate') {
        rehydrateClientHostedBrowserPages(target.pages, {
          listWorkspaceSessions: () => [h.profile.session],
          isKnownWorktree: () => true
        })
        expect(target.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
      }
      const next = target.attach()
      await vi.waitFor(() =>
        expect(target.pages.getPage('slow')?.url).toBe('https://example.internal/C')
      )
      expect(
        target.commands.findLast((event) => event.command.type === 'navigate')?.command
      ).toEqual({ type: 'navigate', url: 'https://example.internal/C' })
      next.abort()
      await next.completion
      expect(target.errors).toEqual([])
    } finally {
      await resumed?.close()
      await h.close()
    }
  }
)

it.each(['pending', 'stopped'] as const)(
  'passes an ordinary valid long address through the %s action and actual native commit',
  async (phase) => {
    const h = createRecoveryLoop(['slow'])
    const started = h.hold('slow')
    const url = `https://example.internal/${'x'.repeat(8300)}`
    const native = h.hold('x'.repeat(8300))
    try {
      h.attach()
      await started
      if (phase === 'stopped') {
        expect(await action(h, 'stop')).toMatchObject({ ok: true })
      }
      expect(await action(h, 'navigate', url)).toMatchObject({ ok: true })
      await native
      const inventory = h.executor.snapshotPageInventory()
      expect(inventory[0]).not.toHaveProperty('currentUrl')
      expect(prepareBrowserClientPageInventoryForAttach(inventory)).toHaveLength(1)
      const creation = h.commands.findLast((event) => event.command.type === 'createPage')!
      const navigation = h.commands.findLast((event) => event.command.type === 'navigate')!
      expect(BrowserClientHostCommandEvent.parse(creation).command).toMatchObject({
        initialUrl: url
      })
      expect(BrowserClientHostCommandEvent.parse(navigation).command).toEqual({
        type: 'navigate',
        url
      })
      h.release('x'.repeat(8300), url)
      await vi.waitFor(() =>
        expect(
          h.authority.clientPageInitializations.status('slow', h.pages.getPage('slow')!.placement)
        ).toBeUndefined()
      )
      expect(h.pages.getPage('slow')?.url).toBe(url)
      expect(buildPersistedClientHostedBrowserPages(h.pages.listPages(), 100)[0].url).toBe(url)
      const loaded = workspaceSessionStateSchema.parse(
        JSON.parse(JSON.stringify(h.profile.session))
      )
      const restored = createRecoveryLoop([])
      try {
        rehydrateClientHostedBrowserPages(restored.pages, {
          listWorkspaceSessions: () => [loaded],
          isKnownWorktree: () => true
        })
        expect(restored.pages.getPage('slow')?.url).toBe(url)
        expect(restored.executor.snapshotPageInventory()).toEqual([])
        restored.attach()
        await restored.published('slow')
        await vi.waitFor(() =>
          expect(
            restored.authority.clientPageInitializations.status(
              'slow',
              restored.pages.getPage('slow')!.placement
            )
          ).toBeUndefined()
        )
        expect(restored.pages.getPage('slow')?.url).toBe(url)
        expect(restored.nativeLoop.initializedUrls).toEqual([url])
      } finally {
        await restored.close()
      }
    } finally {
      await h.close()
    }
  }
)

it('keeps the UI successor through a truthful empty reconnect while the prior native close result is in transit', async () => {
  const h = createRecoveryLoop(['slow'])
  const initial = h.hold('slow')
  const closeReply = Promise.withResolvers<void>()
  const physicallyClosed = Promise.withResolvers<void>()
  const initialization = h.authority.clientPageInitializations
  const observe = initialization.observeAttach.bind(initialization)
  vi.spyOn(initialization, 'observeAttach').mockImplementation((state, inventory, complete) => {
    if (state.lease.connectionId === 'connection-2') {
      closeReply.resolve()
    }
    return observe(state, inventory, complete)
  })
  try {
    const first = h.attach()
    await initial
    const cleanup = h.holdRetirement('slow')
    h.hooks.beforeResult = async (event) => {
      if (event.command.type === 'closePage') {
        physicallyClosed.resolve()
        await closeReply.promise
      }
    }
    const requested = h.hold('B')
    expect(await action(h, 'navigate', 'https://example.internal/B')).toMatchObject({ ok: true })
    await cleanup.started
    cleanup.release()
    await physicallyClosed.promise
    const inventory = h.executor.snapshotPageInventory()
    expect(inventory).toEqual([])
    const second = h.attach({ inventory })
    await requested
    h.release('B', 'https://example.internal/B-redirect')
    await vi.waitFor(() =>
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/B-redirect')
    )
    expect(h.nativeLoop.initializedUrls).toEqual([
      'https://example.internal/slow',
      'https://example.internal/B'
    ])
    expect(buildPersistedClientHostedBrowserPages(h.pages.listPages(), 100)[0].url).toBe(
      'https://example.internal/B-redirect'
    )
    expect(h.errors).toEqual([])
    first.abort()
    second.abort()
    await Promise.all([first.completion, second.completion])
  } finally {
    closeReply.resolve()
    await h.close()
  }
})
