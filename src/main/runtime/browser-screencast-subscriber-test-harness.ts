import { expect, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeBrowserDriverState } from '../../shared/runtime-types'

export const HARNESS_WORKTREE_ID = 'repo-1::/tmp/worktree-a'
export const HARNESS_PAGE_ID = 'page-1'

const store = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [store.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

type Session = { stop: () => void; done: Promise<void>; stops: () => number }

export type ScreencastSubscriber = {
  done: Promise<void>
  stop: () => void
  stops: () => number
  streaming: () => Promise<void>
}

export type ScreencastHarness = {
  runtime: OrcaRuntimeService
  subscribe: (options: {
    connectionId: string
    clientKind?: 'mobile' | 'runtime'
  }) => ScreencastSubscriber
  driver: () => RuntimeBrowserDriverState | undefined
}

/**
 * A runtime whose Chromium-facing screencast is replaced by a fake session per subscriber, so tests
 * drive the real subscription state machine without a browser.
 */
export function createScreencastHarness(): ScreencastHarness {
  const runtime = new OrcaRuntimeService(store as unknown as never)
  let seq = 0
  const browserScreencast = vi.fn(async () => {
    const subscriptionId = `browser-screencast:${HARNESS_PAGE_ID}:${++seq}`
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    let stops = 0
    const session: Session = {
      stop: () => {
        stops += 1
        settle()
      },
      done,
      stops: () => stops
    }
    return {
      subscriptionId,
      ready: {
        type: 'ready' as const,
        subscriptionId,
        browserPageId: HARNESS_PAGE_ID,
        format: 'jpeg' as const,
        tab: {
          browserPageId: HARNESS_PAGE_ID,
          index: 0,
          url: 'about:blank',
          title: 'Browser',
          active: true
        }
      },
      flushPendingFrame: () => {},
      session
    }
  })
  ;(runtime as unknown as { browserCommands: unknown }).browserCommands = { browserScreencast }

  const subscribe = (options: {
    connectionId: string
    clientKind?: 'mobile' | 'runtime'
  }): ScreencastSubscriber => {
    const calls = browserScreencast.mock.results.length
    const emit = vi.fn()
    const done = runtime.browserScreencast(
      { worktree: `id:${HARNESS_WORKTREE_ID}`, page: HARNESS_PAGE_ID, format: 'jpeg' },
      { ...options, sendBinary: vi.fn(), emit }
    )
    const started = (): Promise<{ session: Session }> =>
      browserScreencast.mock.results[calls]?.value as Promise<{ session: Session }>
    let sessionRef: Session | null = null
    void started()?.then((value) => {
      sessionRef = value.session
    })
    return {
      done,
      stop: () => {
        void started()?.then(({ session }) => session.stop())
      },
      stops: () => sessionRef?.stops() ?? 0,
      // Why: every absence assertion in these suites must not be allowed to pass before the
      // subscriber reached the point where the signal it is checking would have been set.
      streaming: () =>
        vi.waitFor(() =>
          expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
        )
    }
  }

  return {
    runtime,
    subscribe,
    driver: () => runtime.getAllBrowserDrivers().get(HARNESS_PAGE_ID)
  }
}
