// hostWindow says only what the host window's send returned, and whether a window exists at all.
import { afterEach, expect, it, vi } from 'vitest'
import { setRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import { partialRuntimeStore } from '../../construction/test-context/runtime-store-partial-fixture'
import type { RuntimeNotifier } from '../../client/events/runtime-notifier-contract'
import { OrcaRuntimeService } from '../../orca-runtime'

const REPO = { id: 'repo', path: '/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
const WORKTREE_ID = 'repo::/scan'
const WINDOW_ID = 7

function runtimeWith(sent: boolean | undefined | 'no-notifier', windowOpen: boolean) {
  setRuntimeDesktopSurface({
    showNotification: () => false,
    hasWindow: (id) => windowOpen && id === WINDOW_ID,
    hasLiveRenderer: () => windowOpen,
    sendToWindow: () => windowOpen,
    requestRenderer: () => Promise.reject(new Error('unexpected renderer request'))
  })
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => [REPO],
      getRepo: (id) => (id === REPO.id ? REPO : undefined)
    })
  )
  Object.assign(runtime, {
    resolveGitWorktreeSelector: async () => ({ id: WORKTREE_ID, repoId: REPO.id }),
    wakeWorkspaceVm: async () => null,
    getExistingOrchestrationDb: () => null
  })
  runtime.attachWindow(WINDOW_ID)
  runtime.markGraphReady(WINDOW_ID)
  const activateWorktree = vi.fn(() => (sent === 'no-notifier' ? undefined : sent))
  if (sent !== 'no-notifier') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activation reaches only activateWorktree on this notifier.
    runtime.setNotifier({ activateWorktree } as unknown as RuntimeNotifier)
  }
  return { runtime, activateWorktree }
}

afterEach(() => {
  setRuntimeDesktopSurface(null)
})

it.each([
  // [send result, window open, hostWindow]
  [true, true, 'requested'],
  [false, true, 'unavailable'],
  [false, false, 'none'],
  // A notifier that reports nothing is not evidence of a send.
  [undefined, true, 'unavailable'],
  [undefined, false, 'none'],
  ['no-notifier', false, 'none']
] as const)('send %s with window open %s reports %s', async (sent, windowOpen, hostWindow) => {
  const { runtime, activateWorktree } = runtimeWith(sent, windowOpen)
  const result = await runtime.activateManagedWorktree(`id:${WORKTREE_ID}`, { navigation: 'host' })
  expect(result.hostWindow).toBe(hostWindow)
  if (sent !== 'no-notifier') {
    expect(activateWorktree).toHaveBeenCalledWith(
      REPO.id,
      WORKTREE_ID,
      undefined,
      undefined,
      undefined
    )
  }
})

it('reports no host window outcome when the activation does not target the host', async () => {
  const { runtime, activateWorktree } = runtimeWith(true, true)
  Object.assign(runtime, {
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => undefined,
    refreshMobileSessionPtyRecords: async () => undefined,
    notifyMobileSessionTabsChanged: () => undefined
  })
  const result = await runtime.activateManagedWorktree(`id:${WORKTREE_ID}`, {
    navigation: 'caller'
  })
  expect(result).not.toHaveProperty('hostWindow')
  expect(activateWorktree).not.toHaveBeenCalled()
})
