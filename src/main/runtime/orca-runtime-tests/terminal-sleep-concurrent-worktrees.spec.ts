import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  store,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import type { PtyProcessInfo } from '../../providers/pty-process-info'
import { spawnWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

describe('concurrent worktree terminal sleeps', () => {
  it('verifies sleep without waiting for a pending background poll or reviving its old PTY', async () => {
    vi.useFakeTimers()
    const live: PtyProcessInfo[] = [
      {
        id: 'persisted-pty',
        cwd: MOCK_GIT_WORKTREES[0].path,
        title: 'bash',
        worktreeId: TEST_WORKTREE_ID
      }
    ]
    const listings: {
      reply: ReturnType<typeof deferred<PtyProcessInfo[]>>
      snapshot: PtyProcessInfo[]
    }[] = []
    let draining = false
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({ activeWorktreeId: null, activeTabId: null })
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      live.splice(0)
      runtime.onPtyExit(ptyId, 0)
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: () => {
        if (draining) {
          return Promise.resolve([...live])
        }
        const reply = deferred<PtyProcessInfo[]>()
        listings.push({ reply, snapshot: [...live] })
        return reply.promise
      }
    })
    const sleeping = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const polling: ReturnType<typeof runtime.listTerminals>[] = []
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(listings).toHaveLength(1)
      polling.push(runtime.listTerminals())
      await vi.advanceTimersByTimeAsync(0)
      expect(listings).toHaveLength(2)
      listings[0].reply.resolve(listings[0].snapshot)
      await vi.advanceTimersByTimeAsync(0)
      expect(stopAndWait).toHaveBeenCalledExactlyOnceWith('persisted-pty', expect.any(Object))
      expect(listings).toHaveLength(3)
      polling.push(runtime.listTerminals())
      await vi.advanceTimersByTimeAsync(0)
      expect(listings).toHaveLength(4)
      listings[2].reply.resolve(listings[2].snapshot)
      await expect(sleeping).resolves.toMatchObject({
        postStopVerified: true,
        stoppedPtyIds: ['persisted-pty']
      })
    } finally {
      draining = true
      for (const { reply, snapshot } of listings) {
        reply.resolve(snapshot)
      }
      await Promise.allSettled([sleeping, ...polling])
      vi.useRealTimers()
    }
    expect((await runtime.listTerminals()).terminals).toEqual([])
    expect(
      runtime.shutdownReconnectFactsFor(getSession(), 'local').activeWorktreeIdsOnShutdown
    ).toEqual([])
    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, null), {
        refuseSleptWorktree: true
      })
    ).rejects.toThrow('worktree_terminals_sleeping')
    const release = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(TEST_WORKTREE_ID, null)
    )
    release()
  })

  it.each([2, 3])('sleeps %i worktrees at once on one PTY controller', async (count) => {
    const worktrees = Array.from({ length: count }, (_, index) =>
      index === 0
        ? { path: MOCK_GIT_WORKTREES[0].path, id: TEST_WORKTREE_ID }
        : {
            path: `/tmp/worktree-${index}`,
            id: `${TEST_REPO_ID}::/tmp/worktree-${index}`
          }
    )
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      ...worktrees.slice(1).map((worktree, index) => ({
        path: worktree.path,
        head: `head-${index}`,
        branch: `feature/${index}`,
        isBare: false,
        isMainWorktree: false
      }))
    ])
    const live = new Map(
      worktrees.map((worktree, index) => [
        `pty-${index}`,
        { id: `pty-${index}`, cwd: worktree.path, title: 'bash', worktreeId: worktree.id }
      ])
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async (ptyId: string) => {
        live.delete(ptyId)
        runtime.onPtyExit(ptyId, 0)
        return true
      }),
      getForegroundProcess: async () => null,
      // Why a delay: a real daemon answers on a later turn, so the sleeps' listings overlap.
      listProcesses: async () => {
        const snapshot = [...live.values()]
        await new Promise((resolve) => setTimeout(resolve, 5))
        return snapshot
      }
    })

    const results = await Promise.all(
      worktrees.map((worktree) => runtime.sleepTerminalsForWorktree(`id:${worktree.id}`))
    )

    expect(results.map((result) => result.postStopVerified)).toEqual(worktrees.map(() => true))
    expect(results.flatMap((result) => result.stoppedPtyIds).sort()).toEqual(
      worktrees.map((_, index) => `pty-${index}`)
    )
    expect(live.size).toBe(0)
  })
})
