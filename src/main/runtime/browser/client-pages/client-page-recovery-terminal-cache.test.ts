import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

it('keeps an admitted exact close across earlier creation-result eviction', async () => {
  const h = createRecoveryLoop(['slow', 'fast', 'b', 'c', 'd', 'queued'], {
    maxCachedCommandResults: 6
  })
  try {
    const started = ['slow', 'b', 'c', 'd'].map((id) => h.hold(id))
    const attached = h.attach()
    await Promise.all(started)
    await h.published('fast')
    expect(h.commands.some((event) => event.browserPageId === 'queued')).toBe(false)
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
    await vi.waitFor(() =>
      expect(h.results.findLast((result) => result.id === 'slow')).toMatchObject({
        type: 'closePage',
        status: 'completed'
      })
    )
    expect(
      h.results
        .filter((result) => result.id === 'slow')
        .map((result) => [result.type, result.status])
    ).toEqual([
      ['createPage', 'completed'],
      ['navigate', 'failed'],
      ['closePage', 'completed']
    ])
    await h.published('queued')
    expect(h.authority.getClientPageExecutionHostKey('slow')).toBeUndefined()
    expect(h.authority.getClientPageExecutionHostKey('queued')).toBe('execution-host-a')
    expect(h.native.order.indexOf('retire-guest')).toBeLessThan(
      h.native.order.indexOf('release-session')
    )
    for (const id of ['b', 'c', 'd']) {
      h.release(id)
    }
    attached.abort()
    await attached.completion
  } finally {
    await h.close()
  }
})

it('rejects a genuine missing native page after its bootstrap results were evicted', async () => {
  const ids = ['missing', 'a', 'b', 'c', 'd', 'e', 'f']
  const h = createRecoveryLoop(ids, { maxCachedCommandResults: 6 })
  try {
    const attached = h.attach()
    await Promise.all(ids.map((id) => h.published(id)))
    const page = h.pages.getPage('missing')!
    expect(await h.executor.retirePage('missing', page.placement.pageHostGeneration)).toBe(true)
    const identity = {
      authorityRuntimeId: h.authority.authorityRuntimeId,
      authorityEpoch: h.authority.authorityEpoch,
      browserPageId: 'missing',
      ...page.placement
    }
    const close = h.authority.issueClientPageCommand(identity, {
      type: 'closePage',
      targetAuthority: identity
    })
    expect(await close.result).toMatchObject({ status: 'failed' })
    expect(
      h.executor.snapshotPageInventory().some((page) => page.browserPageId === 'missing')
    ).toBe(false)
    attached.abort()
    await attached.completion
  } finally {
    await h.close()
  }
})

it('cancels an admitted queued close on dispatcher teardown without claiming native cleanup', async () => {
  const h = createRecoveryLoop(['slow', 'fast'], {
    maxCachedCommandResults: 6,
    maxConcurrentHandlers: 1
  })
  try {
    const navigating = h.hold('slow')
    const attached = h.attach()
    await navigating
    const retirement = h.holdRetirement('slow')
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
    await retirement.started
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const closing = h.closeClientDispatcher()
    await vi.advanceTimersByTimeAsync(5001)
    await closing
    expect(
      h.results.findLast((result) => result.id === 'slow' && result.type === 'closePage')
    ).toMatchObject({ status: 'failed' })
    expect(h.executor.snapshotPageInventory().some((page) => page.browserPageId === 'slow')).toBe(
      true
    )
    expect(h.pages.getPage('slow')).toBeUndefined()
    expect(() => h.authority.select('client-a')).toThrow('browser_host_unavailable')
    expect(h.authority.getClientPageExecutionHostKey('slow')).toBeUndefined()
    retirement.release()
    await vi.waitFor(() =>
      expect(h.executor.snapshotPageInventory().some((page) => page.browserPageId === 'slow')).toBe(
        false
      )
    )
    attached.abort()
    await attached.completion
  } finally {
    vi.useRealTimers()
    await h.close()
  }
})
