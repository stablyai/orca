import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

it.each(['no-close', 'close-first', 'retire-first'] as const)(
  'forgets fully retired cleanup authority with %s and preserves a freshly offered foreign tab',
  async (order) => {
    const h = createRecoveryLoop([])
    const attempted = Promise.withResolvers<void>()
    try {
      await h.seedNative(['foreign'])
      const inventory = h.executor.snapshotPageInventory()
      h.hooks.delivery = (event, dispatch) => {
        if (event.command.type === 'closePage') {
          attempted.resolve()
        } else {
          dispatch()
        }
      }
      const first = h.attach()
      await attempted.promise
      const page = h.pages.getPage('foreign')!
      expect(page.placement.pageHostGeneration).toBe(0)
      const close = () =>
        retireRuntimeBrowserClientPage(
          {
            getBrowserHostLeaseRegistry: () => h.authority,
            notifyHeadlessBrowserSessionTabsChanged: (id) =>
              h.hostRuntime.notifyMobileSessionTabsChanged(id),
            getRuntimeBrowserPageRegistry: () => h.pages,
            resolveBrowserWorkspace: async () => ({ id: page.workspaceId })
          },
          page
        )
      if (order === 'close-first') {
        await close()
      }
      h.fence()
      if (order === 'retire-first') {
        await close()
      }
      expect(h.pages.getPage('foreign') === undefined).toBe(order !== 'no-close')
      expect(h.executor.snapshotPageInventory()).toEqual(inventory)
      first.abort()
      await first.completion
      h.hooks.delivery = undefined
      const next = h.attach({ inventory })
      await h.published('foreign')
      expect(h.pages.getPage('foreign')?.url).toBe('https://example.internal/foreign')
      expect(h.authority.getClientPageExecutionHostKey('foreign')).toBe('execution-host-a')
      expect(h.executor.snapshotPageInventory()).toHaveLength(1)
      next.abort()
      await next.completion
    } finally {
      await h.close()
    }
  }
)

it('releases closed fresh-id scopes repeatedly before a fresh full-sized import', async () => {
  const h = createRecoveryLoop([])
  try {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const id = `old-${cycle}`
      const attempted = Promise.withResolvers<void>()
      await h.seedNative([id])
      h.hooks.delivery = (event, dispatch) => {
        if (event.command.type === 'closePage') {
          attempted.resolve()
        } else {
          dispatch()
        }
      }
      const first = h.attach()
      await attempted.promise
      const page = h.pages.getPage(id)!
      await retireRuntimeBrowserClientPage(
        {
          getBrowserHostLeaseRegistry: () => h.authority,
          notifyHeadlessBrowserSessionTabsChanged: (workspace) =>
            h.hostRuntime.notifyMobileSessionTabsChanged(workspace),
          getRuntimeBrowserPageRegistry: () => h.pages,
          resolveBrowserWorkspace: async () => ({ id: page.workspaceId })
        },
        page
      )
      h.fence()
      first.abort()
      await first.completion
      await h.restartClient()
      expect(h.pages.listPages()).toEqual([])
      expect(h.executor.snapshotPageInventory()).toEqual([])
      expect(h.authority.getPlacement(id)).toBeUndefined()
      expect(h.authority.getClientPageExecutionHostKey(id)).toBeUndefined()
    }
    const ids = Array.from({ length: 256 }, (_, index) => `fresh-${index}`)
    await h.seedNative(ids)
    for (const id of ids) {
      h.hold(id)
    }
    h.hooks.delivery = undefined
    const next = h.attach()
    await vi.waitFor(() => expect(h.pages.listPages()).toHaveLength(256))
    expect(h.pages.listPages().every((page) => page.browserPageId.startsWith('fresh-'))).toBe(true)
    next.abort()
    await next.completion
  } finally {
    await h.close()
  }
})
