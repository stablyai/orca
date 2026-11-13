import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { ordinaryPageRpc } from './client-page-ordinary-request-test-harness'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { browserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'

const WORKSPACE = 'repo-1::/tmp/worktree-a'

it.each([
  ['browser.tabCreate', false],
  ['browser.openUrl', false],
  ['browser.tabCreate', true],
  ['browser.openUrl', true]
] as const)(
  'cancels a real %s request (remote=%s) before preparation without late allocation',
  async (method, remote) => {
    const h = createRecoveryLoop([])
    try {
      h.pages.publishClientPage({
        browserPageId: 'slow',
        workspaceId: WORKSPACE,
        browserProfileId: 'default',
        pairedDeviceId: 'device-a',
        placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
        executionHostKey: 'old-key',
        url: 'https://example.internal/slow',
        loading: false,
        active: false
      })
      await h.seedNative(['slow'], 'default')
      const cleanup = h.holdRetirement('slow')
      h.attach()
      await cleanup.started
      const request = ordinaryPageRpc(h, remote)
      const entered = Promise.withResolvers<void>()
      const original = h.authority.createClientPage.bind(h.authority)
      vi.spyOn(h.authority, 'createClientPage').mockImplementation((options) => {
        const result = original(options)
        entered.resolve()
        return result
      })
      const aborted = new AbortController()
      const reply = request(method, 'abandoned', aborted.signal)
      await entered.promise
      aborted.abort()
      expect(await reply).toEqual([expect.objectContaining({ ok: false })])
      expect(h.commands.some((c) => c.command.type === 'createPage')).toBe(false)
      cleanup.release()
      await h.published('slow')
      expect(
        h.commands.filter((c) => c.command.type === 'createPage').map((c) => c.browserPageId)
      ).toEqual(['slow'])
      expect(h.pages.listPages().map((p) => p.browserPageId)).toEqual(['slow'])
    } finally {
      await h.close()
    }
  }
)

it('keeps exact ordinary allocation cleanup charged after cancellation and leaves a committed handoff alive on later abort', async () => {
  const h = createRecoveryLoop([])
  try {
    h.attach()
    const mount = h.holdMount('ordinary')
    const cleanup = h.holdRetirement('ordinary')
    const signal = new AbortController()
    const creating = h.authority.createClientPage({
      browserPageId: 'ordinary',
      browserHostClientId: 'client-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a',
      workspaceId: WORKSPACE,
      signal: signal.signal
    })
    const rejected = expect(creating).rejects.toThrow('browser_host_page_creation_cancelled')
    await mount.started
    signal.abort()
    await rejected
    expect(h.authority.getPlacement('ordinary')).toBeUndefined()
    // Reusing the still-native id cannot bypass the existing exact cleanup owner.
    await expect(
      h.authority.createClientPage({
        browserPageId: 'ordinary',
        browserHostClientId: 'client-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-a',
        executionHostKey: 'execution-host-a',
        timeoutMs: 5
      })
    ).rejects.toThrow('browser_host_page_creation_timeout')
    // A different ready profile cannot reuse an id still owned by exact cleanup.
    await expect(
      h.authority.createClientPage({
        browserPageId: 'ordinary',
        browserHostClientId: 'client-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-b',
        executionHostKey: 'rejected-key'
      })
    ).rejects.toThrow('browser_page_replacement_requires_retirement')
    expect(() =>
      h.authority.requireExecutionHost(h.authority.select('client-a'), 'rejected-key')
    ).toThrow()
    mount.release()
    await cleanup.started
    expect(h.executor.snapshotPageInventory().some((p) => p.browserPageId === 'ordinary')).toBe(
      true
    )
    cleanup.release()
    await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
    const later = new AbortController()
    const placement = await h.authority.createClientPage({
      browserPageId: 'handed-off',
      browserHostClientId: 'client-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-b',
      executionHostKey: 'execution-host-a',
      signal: later.signal
    })
    later.abort()
    expect(h.authority.getPlacement('handed-off')).toEqual(placement)
    expect(h.executor.snapshotPageInventory().map((p) => p.browserPageId)).toEqual(['handed-off'])
  } finally {
    await h.close()
  }
})

it('rejects a real duplicate tabCreate without changing the clean stopped saved row', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    const started = h.hold('slow')
    h.attach()
    await started
    const old = h.pages.getPage('slow')!
    expect(h.authority.clientPageInitializations.stop('slow', old.placement)).toBe(true)
    await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
    const row = h.pages.getPage('slow')
    const creates = h.commands.filter((c) => c.command.type === 'createPage').length
    expect(
      await ordinaryPageRpc(h)('browser.tabCreate', 'slow', new AbortController().signal)
    ).toEqual([expect.objectContaining({ ok: false })])
    expect(h.pages.getPage('slow')).toEqual(row)
    expect(h.authority.clientPageInitializations.status('slow', old.placement)).toBe('stopped')
    expect(h.authority.getPlacement('slow')).toBeUndefined()
    expect(h.commands.filter((c) => c.command.type === 'createPage')).toHaveLength(creates)
    expect(h.executor.snapshotPageInventory()).toEqual([])
  } finally {
    await h.close()
  }
})

it('rechecks the current attach between ready listeners, drops an aborted waiter and admits a live request once', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    await h.seedNative(['slow'])
    const cleanup = h.holdRetirement('slow')
    const first = h.attach()
    await cleanup.started
    const cancelled = new AbortController()
    let reattached = false
    const create = (id: string, signal?: AbortSignal) =>
      h.authority.createClientPage({
        browserPageId: id,
        browserHostClientId: 'client-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-a',
        executionHostKey: 'execution-host-a',
        signal
      })
    h.hooks.delivery = (event, dispatch) => {
      if (!reattached && event.browserPageId === 'trigger' && event.command.type === 'createPage') {
        reattached = true
        h.attach()
        first.abort()
        cancelled.abort()
      }
      dispatch()
    }
    const trigger = create('trigger')
    const dropped = expect(create('cancelled', cancelled.signal)).rejects.toThrow(
      'browser_host_page_creation_cancelled'
    )
    const live = create('live')
    cleanup.release()
    await Promise.all([trigger, dropped, live])
    expect(h.authority.select('client-a').connectionId).toBe('connection-2')
    expect(
      h.commands.filter((c) => c.command.type === 'createPage' && c.browserPageId === 'live')
    ).toHaveLength(1)
    expect(h.commands.some((c) => c.browserPageId === 'cancelled')).toBe(false)
    expect(h.authority.getPlacement('live')?.kind).toBe('client')
  } finally {
    await h.close()
  }
})

it('retires a preparation waiter on full authority death without late creation', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    await h.seedNative(['slow'])
    const cleanup = h.holdRetirement('slow')
    h.attach()
    await cleanup.started
    const creating = h.authority.createClientPage({
      browserPageId: 'abandoned',
      browserHostClientId: 'client-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a'
    })
    const rejected = expect(creating).rejects.toThrow('browser_host_lease_stale')
    h.fence()
    await rejected
    cleanup.release()
    expect(h.commands.some((c) => c.browserPageId === 'abandoned')).toBe(false)
    expect(h.authority.getPlacement('abandoned')).toBeUndefined()
  } finally {
    await h.close()
  }
})

it('keeps a successful real RPC handoff alive after caller cancellation', async () => {
  const h = createRecoveryLoop([])
  try {
    h.attach()
    const cancelled = new AbortController()
    expect(await ordinaryPageRpc(h)('browser.tabCreate', 'handed-off', cancelled.signal)).toEqual([
      expect.objectContaining({ ok: true })
    ])
    cancelled.abort()
    expect(h.pages.getPage('handed-off')?.placement).toEqual(h.authority.getPlacement('handed-off'))
    expect(h.executor.snapshotPageInventory().map((p) => p.browserPageId)).toEqual(['handed-off'])
  } finally {
    await h.close()
  }
})

it('transfers a real logical-capacity publication failure to exact cleanup until its join', async () => {
  const h = createRecoveryLoop([])
  try {
    h.attach()
    // Seal the empty attach through an ordinary successfully published caller first.
    const request = ordinaryPageRpc(h)
    expect(await request('browser.tabCreate', 'first', new AbortController().signal)).toEqual([
      expect.objectContaining({ ok: true })
    ])
    for (let i = 0; i < 255; i += 1) {
      h.pages.publishClientPage({
        browserPageId: `saved-${i}`,
        workspaceId: WORKSPACE,
        browserProfileId: 'default',
        pairedDeviceId: 'device-a',
        placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
        executionHostKey: 'saved-key',
        url: 'https://example.internal/saved',
        loading: false,
        active: false
      })
    }
    const cleanup = h.holdRetirement('over-capacity')
    expect(
      await request('browser.tabCreate', 'over-capacity', new AbortController().signal)
    ).toEqual([expect.objectContaining({ ok: false })])
    await cleanup.started
    expect(h.pages.getPage('over-capacity')).toBeUndefined()
    expect(h.authority.getPlacement('over-capacity')).toBeUndefined()
    expect(
      h.executor.snapshotPageInventory().some((p) => p.browserPageId === 'over-capacity')
    ).toBe(true)
    // One successful page and the failed native allocation each still own a placement slot.
    for (let i = 0; i < 254; i += 1) {
      h.authority.placeServerPage(`slot-${i}`)
    }
    expect(() => h.authority.placeServerPage('blocked')).toThrow()
    cleanup.release()
    await vi.waitFor(() =>
      expect(h.executor.snapshotPageInventory().map((p) => p.browserPageId)).toEqual(['first'])
    )
    expect(h.authority.placeServerPage('released')).toEqual({ kind: 'server' })
    const key = browserNetworkExecutionHostKey({
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 1
    })
    // The successful first page still owns this route grant after failed-page cleanup.
    expect(() =>
      h.authority.requireExecutionHost(h.authority.select('client-a'), key)
    ).not.toThrow()
    expect(h.pages.getPage('first')).toBeDefined()
  } finally {
    await h.close()
  }
})

it('keeps the created tab usable when an older desktop cannot receive its long initial URL', async () => {
  const h = createRecoveryLoop([])
  try {
    h.attach({ modern: false })
    const request = ordinaryPageRpc(h)
    const long = `https://example.internal/${'x'.repeat(8300)}`
    const before = h.authority.select('client-a')
    expect(await request('browser.openUrl', 'long', new AbortController().signal, long)).toEqual([
      expect.objectContaining({ ok: true })
    ])
    expect(h.commands.some((event) => event.command.type === 'createPage')).toBe(true)
    expect(
      h.commands.some((event) => event.command.type === 'navigate' && event.command.url === long)
    ).toBe(false)
    expect(h.authority.select('client-a')).toEqual(before)
    expect(await request('browser.openUrl', 'short', new AbortController().signal)).toEqual([
      expect.objectContaining({ ok: true })
    ])
    expect(
      h.commands.some(
        (event) =>
          event.command.type === 'navigate' && event.command.url === 'https://example.internal/new'
      )
    ).toBe(true)
    expect(h.authority.select('client-a')).toEqual(before)
    expect(h.errors).toEqual([])
  } finally {
    await h.close()
  }
})
