import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { MOCK_GIT_WORKTREES } from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../workspaces/removal/worktree-teardown'
import '../workspaces/removal/worktree-teardown-deadline'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import {
  TEST_WORKTREE_ID,
  makeDeferred,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('awaits physical PTY stop when destructive teardown supplies shared dedupe', async () => {
    const runtime = new OrcaRuntimeService(store)
    const physicalStop = makeDeferred()
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => {
      await physicalStop.promise
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)
    const stopPty = vi.fn(async (_ptyId: string, stop: () => Promise<boolean>) => ({
      stopped: await stop(),
      owner: true
    }))

    const stopping = runtime.stopTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, { stopPty })
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledWith('pty-1'))
    expect(kill).not.toHaveBeenCalled()
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    physicalStop.resolve()
    await expect(stopping).resolves.toEqual({ stopped: 1 })
  })

  it('fails terminal stop closed if the graph reloads during selector resolution', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const stopPromise = runtime.stopTerminalsForWorktree('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(stopPromise).rejects.toThrow('runtime_unavailable')
    expect(killed).toBe(false)
  })

  it('does not stop a reused PTY after the teardown deadline passes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const killed = vi.fn(() => true)
      runtime.setPtyController({
        write: () => true,
        kill: killed,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      await runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Claude',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'reused-pty'
          }
        ]
      })

      let releaseListWorktrees = () => {}
      vi.mocked(listWorktrees).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
          })
      )
      const stopPromise = runtime.stopTerminalsForWorktree('branch:feature/foo', {
        deadline: Date.now() + 25
      })

      await vi.advanceTimersByTimeAsync(25)
      releaseListWorktrees()

      await expect(stopPromise).resolves.toEqual({ stopped: 0 })
      expect(killed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
