import { BrowserHostCommandLedger } from '../../browser-host/commands/browser-host-command-ledger'
import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

it.each(['create', 'gap', 'navigate', 'publication'])(
  'logical close during %s retires the exact initialization without a late saved row',
  async (phase) => {
    const h = createRecoveryLoop(['slow', 'fast'])
    const closed = Promise.withResolvers<void>()
    const close = () => {
      const page = h.pages.getPage('slow')
      if (!page) {
        return
      }
      void retireRuntimeBrowserClientPage(
        {
          getBrowserHostLeaseRegistry: () => h.authority,
          notifyHeadlessBrowserSessionTabsChanged: (id) =>
            h.hostRuntime.notifyMobileSessionTabsChanged(id),
          getRuntimeBrowserPageRegistry: () => h.pages,
          resolveBrowserWorkspace: async () => ({ id: 'workspace' })
        },
        page
      ).then(() => closed.resolve(), closed.reject)
    }
    if (phase === 'gap') {
      h.hooks.onResult = (event) => {
        if (event.browserPageId === 'slow' && event.command.type === 'createPage') {
          close()
        }
      }
    }
    if (phase === 'publication') {
      h.hooks.onNotify = () => {
        if (h.pages.getPage('slow')?.placement.pageHostGeneration) {
          close()
        }
      }
    }
    try {
      const mount = phase === 'create' ? h.holdMount('slow') : undefined
      const navigating = phase === 'navigate' ? h.hold('slow') : undefined
      const attached = h.attach()
      if (mount) {
        await mount.started
        close()
        mount.release()
      }
      if (navigating) {
        await navigating
        close()
      }
      await closed.promise
      await h.published('fast')
      await vi.waitFor(() =>
        expect(h.executor.snapshotPageInventory().map((page) => page.browserPageId)).toEqual([
          'fast'
        ])
      )
      expect(h.pages.getPage('slow')).toBeUndefined()
      expect(h.authority.getPlacement('slow')).toBeUndefined()
      expect(h.authority.getClientPageExecutionHostKey('slow')).toBeUndefined()
      expect(h.authority.getClientPageExecutionHostKey('fast')).toBe('execution-host-a')
      expect(
        h.profile.session.clientHostedBrowserPagesByWorktree?.['repo-1::/tmp/worktree-a']?.map(
          (page) => page.browserPageId
        )
      ).toEqual(['fast'])
      expect(h.results.findLast((result) => result.id === 'slow')).toMatchObject({
        type: 'closePage',
        status: 'completed'
      })
      attached.abort()
      await attached.completion
    } finally {
      await h.close()
    }
  }
)

it.each([false, true])(
  'a transport exception after delivery=%s retains exact uncertainty until fresh inventory',
  async (received) => {
    const h = createRecoveryLoop(['slow'])
    const attempted = Promise.withResolvers<void>()
    h.hooks.delivery = (event, dispatch) => {
      if (event.command.type === 'createPage') {
        if (received) {
          dispatch()
        }
        attempted.resolve()
        throw new Error('transport-lost')
      }
      dispatch()
    }
    try {
      const first = h.attach()
      await attempted.promise
      await first.completion
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
      expect(h.authority.getClientPageExecutionHostKey('slow')).toBeUndefined()
      h.hooks.delivery = undefined
      const next = h.attach()
      await h.published('slow')
      expect(h.executor.snapshotPageInventory()).toHaveLength(1)
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
      expect(h.authority.getClientPageExecutionHostKey('slow')).toBe('execution-host-a')
      next.abort()
      await next.completion
    } finally {
      await h.close()
    }
  }
)

it('a real ledger rejection before admission creates no native cleanup obligation', async () => {
  const h = createRecoveryLoop(['slow'])
  const rejected = Promise.withResolvers<void>()
  const issue = BrowserHostCommandLedger.prototype.issue
  let admissions = 0
  let rejectFirst = true
  const observed = vi
    .spyOn(BrowserHostCommandLedger.prototype, 'issue')
    .mockImplementation(function (this: BrowserHostCommandLedger, input, onAdmitted) {
      if (rejectFirst && input.command.type === 'createPage') {
        rejectFirst = false
        this.detachDelivery()
        try {
          return issue.call(this, input, () => {
            admissions += 1
            onAdmitted?.()
          })
        } catch (error) {
          rejected.resolve()
          throw error
        }
      }
      return issue.call(this, input, onAdmitted)
    })
  try {
    const first = h.attach()
    await rejected.promise
    expect(admissions).toBe(0)
    expect(h.commands).toEqual([])
    expect(h.executor.snapshotPageInventory()).toEqual([])
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    first.abort()
    await first.completion
    const next = h.attach()
    await h.published('slow')
    expect(h.commands.filter((event) => event.command.type === 'closePage')).toEqual([])
    expect(h.authority.getClientPageExecutionHostKey('slow')).toBe('execution-host-a')
    expect(h.executor.snapshotPageInventory()).toHaveLength(1)
    next.abort()
    await next.completion
  } finally {
    observed.mockRestore()
    await h.close()
  }
})
