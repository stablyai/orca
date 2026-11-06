import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../git/worktrees/catalog/worktree-listing'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './rpc/server/runtime-rpc-worktree-store-fixtures'
import { publishHeadlessRuntimeGraph } from './headless-runtime-graph'

const WORKTREE_PATH = '/tmp/worktree-a'
const WORKTREE_ID = 'repo-1::/tmp/worktree-a'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const worktrees = [
      { path: '/tmp/worktree-a', head: 'abc', branch: 'main', isBare: false, isMainWorktree: false }
    ]
    return {
      listWorktrees: vi.fn().mockResolvedValue(worktrees),
      listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
    }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

function createRuntime(attach: 'headless' | 'window') {
  const setWorktreeMeta = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only the repo and worktree-meta members this fixture provides.
  const runtime = new OrcaRuntimeService({ ...makeStore(), setWorktreeMeta } as never)
  let spawned = 0
  runtime.setPtyController({
    spawn: async () => ({ id: `pty-${++spawned}` }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  if (attach === 'headless') {
    publishHeadlessRuntimeGraph(runtime)
  } else {
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  }
  const activityWrites = () =>
    setWorktreeMeta.mock.calls.filter(([, updates]) => 'lastActivityAt' in updates)
  return { runtime, activityWrites }
}

describe('terminal activity with no window attached', () => {
  it('stamps Recent when a terminal starts and when it exits on its own', async () => {
    const { runtime, activityWrites } = createRuntime('headless')

    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`)
    expect(activityWrites()).toEqual([
      [expect.objectContaining({ id: WORKTREE_ID }), { lastActivityAt: expect.any(Number) }]
    ])

    await runtime.onPtyExit(terminal.ptyId!, 0)
    expect(activityWrites()).toHaveLength(2)
  })

  it('skips a closed terminal, its replayed exit, and a pane started again', async () => {
    const { runtime, activityWrites } = createRuntime('headless')

    await runtime.createTerminal(`path:${WORKTREE_PATH}`, { reopensPane: true })
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, { spawnIntent: 'automatic-restore' })
    expect(activityWrites()).toEqual([])

    const closed = await runtime.createTerminal(`path:${WORKTREE_PATH}`)
    runtime.markPtyStopRequested(closed.ptyId!)
    await runtime.onPtyExit(closed.ptyId!, 0)
    // The stop's cleanup reports the same exit again once the request is spent.
    await runtime.onPtyExit(closed.ptyId!, 0)
    expect(activityWrites()).toHaveLength(1)
  })

  it('leaves Recent to an attached window', async () => {
    const { runtime, activityWrites } = createRuntime('window')

    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`)
    await runtime.onPtyExit(terminal.ptyId!, 0)

    expect(activityWrites()).toEqual([])
  })
})
