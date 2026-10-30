import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'

describe('concurrent worktree terminal sleeps', () => {
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
