import {
  openRecoveryTabsStream,
  publishRecoveryTabsGraph
} from './client-page-recovery-stream-test-harness'
import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

it('a close deadline leaves native capacity charged until the real retirement joins', async () => {
  const h = createRecoveryLoop(['fast', 'a', 'b', 'c', 'd', 'queued'])
  try {
    const started = ['a', 'b', 'c', 'd'].map((id) => h.hold(id))
    const attached = h.attach()
    await Promise.all(started)
    await h.published('fast')
    const fast = h.pages.getPage('fast')!
    const action = h.authority.issueClientPageCommand(
      {
        authorityRuntimeId: h.authority.authorityRuntimeId,
        authorityEpoch: h.authority.authorityEpoch,
        browserPageId: 'fast',
        ...fast.placement
      },
      { type: 'navigate', url: 'https://example.internal/user-action' }
    )
    expect((await action.result).status).toBe('completed')
    const retirement = h.holdRetirement('a')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await retireRuntimeBrowserClientPage(
      {
        getBrowserHostLeaseRegistry: () => h.authority,
        notifyHeadlessBrowserSessionTabsChanged: (id) =>
          h.hostRuntime.notifyMobileSessionTabsChanged(id),
        getRuntimeBrowserPageRegistry: () => h.pages,
        resolveBrowserWorkspace: async () => ({ id: 'workspace' })
      },
      h.pages.getPage('a')!
    )
    await retirement.started
    await vi.advanceTimersByTimeAsync(45_001)
    expect(h.pages.getPage('a')).toBeUndefined()
    expect(h.commands.some((event) => event.browserPageId === 'queued')).toBe(false)
    expect(
      (await h.hostRuntime.snapshotForClient('repo-1::/tmp/worktree-a', 'device-a')).tabs.find(
        (tab) => tab.id === 'queued'
      )
    ).toMatchObject({ type: 'browser', url: 'https://example.internal/queued' })
    expect(h.executor.snapshotPageInventory().some((page) => page.browserPageId === 'a')).toBe(true)
    retirement.release()
    await h.published('queued')
    expect(h.executor.snapshotPageInventory().some((page) => page.browserPageId === 'a')).toBe(
      false
    )
    expect(h.authority.getClientPageExecutionHostKey('a')).toBeUndefined()
    expect(h.authority.getClientPageExecutionHostKey('queued')).toBe('execution-host-a')
    for (const id of ['b', 'c', 'd']) {
      h.release(id)
    }
    attached.abort()
    await attached.completion
  } finally {
    vi.useRealTimers()
    await h.close()
  }
})

it.each([false, true])(
  'same-ledger inventory keeps an outstanding create with fast sibling=%s',
  async (withFast) => {
    const h = createRecoveryLoop(['slow'])
    await publishRecoveryTabsGraph(h.hostRuntime)
    const firstDelivery = Promise.withResolvers<void>()
    const stream = openRecoveryTabsStream(h.hostRuntime, `outstanding-${withFast}`)
    let held = false
    h.hooks.delivery = (event, dispatch) => {
      if (event.command.type === 'createPage' && !held) {
        held = true
        firstDelivery.resolve()
        return
      }
      dispatch()
    }
    try {
      await stream.initial
      expect(
        stream.frames.findLast((frame) => frame.worktree === 'repo-1::/tmp/worktree-a')
          ?.clientHostedPagesUnreconciled
      ).toBe(true)
      await h.seedNative(['slow'])
      const navigation = h.hold('slow')
      const mount = h.holdMount('slow')
      const first = h.attach()
      await firstDelivery.promise
      expect(h.executor.snapshotPageInventory()).toEqual([])
      const retirement = h.holdRetirement('slow')
      if (withFast) {
        await h.seedNative(['fast'])
      }
      const next = h.attach({ inventory: h.executor.snapshotPageInventory() })
      await mount.started
      if (withFast) {
        await h.published('fast')
      }
      expect(
        (await h.hostRuntime.snapshotForClient('repo-1::/tmp/worktree-a', 'device-a'))
          .clientHostedPagesUnreconciled
      ).toBe(true)
      first.abort()
      await first.completion
      mount.release()
      await retirement.started
      expect(
        new Set(
          h.commands
            .filter(
              (event) => event.browserPageId === 'slow' && event.command.type === 'createPage'
            )
            .map((event) => event.commandId)
        ).size
      ).toBe(1)
      expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
      retirement.release()
      await navigation
      h.release('slow')
      await h.published('slow')
      await vi.waitFor(async () =>
        expect(
          (await h.hostRuntime.snapshotForClient('repo-1::/tmp/worktree-a', 'device-a'))
            .clientHostedPagesUnreconciled
        ).toBeUndefined()
      )
      await vi.waitFor(() =>
        expect(
          stream.frames.findLast((frame) => frame.worktree === 'repo-1::/tmp/worktree-a')
            ?.clientHostedPagesUnreconciled
        ).toBeUndefined()
      )
      expect(stream.errors).toEqual([])
      stream.stop()
      await stream.completion
      expect(h.executor.snapshotPageInventory()).toHaveLength(withFast ? 2 : 1)
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
      expect(
        h.results
          .filter((result) => result.id === 'slow')
          .map((result) => [result.type, result.status])
      ).toContainEqual(['closePage', 'completed'])
      expect(h.errors).toEqual([])
      next.abort()
      await next.completion
    } finally {
      stream.stop()
      await h.close()
    }
  }
)

it('an omitted inventory cannot certify a retired native target absent', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    const started = h.hold('slow')
    const first = h.attach()
    await started
    h.fence()
    first.abort()
    await first.completion
    await h.restartClient()
    h.commands.length = 0
    const unavailable = h.attach({ omitInventory: true })
    await Promise.resolve()
    expect(h.commands).toEqual([])
    expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
    const next = h.attach({ inventory: [] })
    h.release('slow')
    await h.published('slow')
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    unavailable.abort()
    next.abort()
    await Promise.all([unavailable.completion, next.completion])
  } finally {
    await h.close()
  }
})

it.each(['native-retirement', 'initialization-failure'] as const)(
  'complete absence after %s retires settled-create nonallocating work before replay',
  async (cause) => {
    const h = createRecoveryLoop(['slow'])
    const pending = Promise.withResolvers<void>()
    const resultDelivery = Promise.withResolvers<void>()
    let heldCommand: string | undefined
    if (cause === 'initialization-failure') {
      h.hooks.failCommit = true
      h.hooks.beforeResult = async (event) => {
        if (event.command.type === 'navigate' && !heldCommand) {
          heldCommand = event.commandId
          pending.resolve()
          await resultDelivery.promise
        }
      }
    } else {
      h.hooks.delivery = (event, dispatch) => {
        if (event.command.type === 'navigate' && !heldCommand) {
          heldCommand = event.commandId
          pending.resolve()
          return
        }
        dispatch()
      }
    }
    try {
      const first = h.attach()
      await pending.promise
      expect(h.results).toContainEqual({ id: 'slow', type: 'createPage', status: 'completed' })
      const inventory = h.executor.snapshotPageInventory()
      if (cause === 'native-retirement') {
        expect(inventory).toHaveLength(1)
        await h.executor.retirePage('slow', inventory[0]!.pageHostGeneration)
      } else {
        expect(inventory).toEqual([])
        h.hooks.failCommit = false
      }
      const next = h.attach({ inventory: [] })
      await h.published('slow')
      expect(h.commands.filter((event) => event.commandId === heldCommand)).toHaveLength(1)
      expect(h.commands.filter((event) => event.command.type === 'createPage')).toHaveLength(2)
      expect(h.executor.snapshotPageInventory()).toHaveLength(1)
      expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
      expect(h.errors).toEqual([])
      resultDelivery.resolve()
      first.abort()
      next.abort()
      await Promise.all([first.completion, next.completion])
    } finally {
      resultDelivery.resolve()
      await h.close()
    }
  }
)
