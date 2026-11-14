import { adoptRuntimeBrowserClientPagesFromInventory } from './runtime-browser-client-page-adoption'
import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import * as persistence from './client-hosted-browser-page-persistence'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

const WORKSPACE = 'repo-1::/tmp/worktree-a'

it.each([
  [25, 750],
  [250, 7500]
])(
  'seeds %i imports with one publication across a %i-worktree session',
  async (count, worktrees) => {
    const ids = Array.from({ length: count }, (_, index) => `page-${index}`)
    const h = createRecoveryLoop([], { worktreeCount: worktrees })
    const originalPersist = persistence.persistClientHostedBrowserPages
    const work = { passes: 0, rows: 0 }
    const measure = vi
      .spyOn(persistence, 'persistClientHostedBrowserPages')
      .mockImplementation((host, registry, id) =>
        originalPersist(
          host,
          {
            listPages: (workspace) => {
              const rows = registry.listPages(workspace)
              work.passes += 1
              work.rows += rows.length
              return rows
            }
          },
          id
        )
      )
    try {
      await h.seedNative(ids)
      for (const id of ids) {
        h.hold(id)
      }
      const attached = h.attach()
      await vi.waitFor(() => expect(h.pages.listPages()).toHaveLength(count))
      expect(work).toEqual({ passes: 1, rows: count })
      expect(h.profile.work).toEqual({ writes: 1, normalizedWorktrees: worktrees })
      expect(h.profile.session.clientHostedBrowserPagesByWorktree?.[WORKSPACE]).toHaveLength(count)
      await adoptRuntimeBrowserClientPagesFromInventory({
        lease: h.authority.select('client-a'),
        authority: h.authority,
        pages: h.pages,
        notifyWorkspace: (id) => h.hostRuntime.notifyMobileSessionTabsChanged(id),
        resolveExecutionHostKey: async () => ({
          status: 'resolved',
          executionHostKey: 'execution-host-a'
        })
      })
      expect(h.profile.work.writes).toBe(1)
      h.release(ids[0]!)
      await h.published(ids[0]!)
      expect(h.pages.getPage(ids[1]!)?.placement.pageHostGeneration).toBe(0)
      expect(
        h.profile.session.clientHostedBrowserPagesByWorktree?.[WORKSPACE]?.find(
          (row) => row.browserPageId === ids[0]
        )?.url
      ).toBe('https://example.internal/page-0')
      attached.abort()
      await attached.completion
    } finally {
      measure.mockRestore()
      await h.close()
    }
  }
)

it('does not resurrect a closed queued import from the next authenticated inventory', async () => {
  const h = createRecoveryLoop([])
  const ids = ['a', 'b', 'c', 'd', 'queued']
  try {
    await h.seedNative(ids)
    const started = ids.slice(0, 4).map((id) => h.hold(id))
    const first = h.attach()
    await Promise.all(started)
    const page = h.pages.getPage('queued')!
    await retireRuntimeBrowserClientPage(
      {
        getBrowserHostLeaseRegistry: () => h.authority,
        notifyHeadlessBrowserSessionTabsChanged: (id) =>
          h.hostRuntime.notifyMobileSessionTabsChanged(id),
        getRuntimeBrowserPageRegistry: () => h.pages,
        resolveBrowserWorkspace: async () => ({ id: WORKSPACE })
      },
      page
    )
    expect(
      h.commands.some(
        (event) => event.browserPageId === 'queued' && event.command.type !== 'closePage'
      )
    ).toBe(false)
    const next = h.attach()
    first.abort()
    await first.completion
    expect(h.pages.getPage('queued')).toBeUndefined()
    expect(
      h.profile.session.clientHostedBrowserPagesByWorktree?.[WORKSPACE]?.some(
        (row) => row.browserPageId === 'queued'
      )
    ).toBe(false)
    h.release('a')
    await h.published('a')
    for (const id of ids.slice(0, 4)) {
      h.release(id)
    }
    await vi.waitFor(() =>
      expect(h.executor.snapshotPageInventory().some((row) => row.browserPageId === 'queued')).toBe(
        false
      )
    )
    expect(
      h.commands.filter(
        (event) => event.browserPageId === 'queued' && event.command.type === 'createPage'
      )
    ).toEqual([])
    next.abort()
    await next.completion
  } finally {
    await h.close()
  }
})
