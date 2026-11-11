import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'

// RA-ORPH: what the exact stop does with processes that outlive the PTY (pty-marked-stragglers.ts).
const reap = vi.hoisted(() => {
  const state: { survivors: number[]; calls: string[] } = { survivors: [], calls: [] }
  return state
})
vi.mock('./pty-marked-stragglers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  killPtyStragglers: async (ptyId: string) => {
    reap.calls.push(ptyId)
    return reap.survivors
  }
}))

const WORKTREE = 'repo::/tmp/exact-reap'
const PTY = `${WORKTREE}@@terminal`
const TAB = '20000000-0000-4000-8000-000000000001'
const LEAF = '20000000-0000-4000-8000-000000000002'
const INCARNATION = '20000000-0000-4000-8000-000000000003'

class ReapRuntime extends OrcaRuntimeService {
  override resolveGitWorktreeSelector(selector: string) {
    return super.resolveGitWorktreeSelector(selector)
  }
  override getResolvedWorktreeMap() {
    return super.getResolvedWorktreeMap()
  }
}

function worktree() {
  const git = {
    path: '/tmp/exact-reap',
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
  return {
    ...git,
    git,
    id: WORKTREE,
    repoId: 'repo',
    displayName: 'exact-reap',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null
  }
}

function runtimeWith(livePty: boolean): ReapRuntime {
  const runtime = new ReapRuntime()
  const wt = worktree()
  vi.spyOn(runtime, 'resolveGitWorktreeSelector').mockResolvedValue(wt)
  vi.spyOn(runtime, 'getResolvedWorktreeMap').mockResolvedValue(new Map([[WORKTREE, wt]]))
  let stopped = !livePty
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async () => {
      runtime.onPtyExit(PTY, 0, INCARNATION, { providerExitObserved: true })
      stopped = true
      return true
    },
    getForegroundProcess: async () => null,
    hasPty: () => !stopped,
    listProcesses: async () =>
      stopped ? [] : [{ id: PTY, incarnationId: INCARNATION, cwd: wt.path, title: 'terminal' }]
  })
  if (livePty) {
    runtime.registerPty(PTY, WORKTREE, null, {
      tabId: TAB,
      leafId: LEAF,
      incarnationId: INCARNATION
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: TAB, worktreeId: WORKTREE, title: 'terminal', activeLeafId: LEAF, layout: null }
      ],
      leaves: [{ tabId: TAB, worktreeId: WORKTREE, leafId: LEAF, paneRuntimeId: 1, ptyId: PTY }]
    })
  } else {
    // The pane's shell already died in an earlier stop: the graph has the tab, with no live PTY.
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: TAB, worktreeId: WORKTREE, title: 'terminal', activeLeafId: LEAF, layout: null }
      ],
      leaves: [{ tabId: TAB, worktreeId: WORKTREE, leafId: LEAF, paneRuntimeId: 1, ptyId: null }]
    })
  }
  return runtime
}

const stop = (runtime: ReapRuntime) =>
  runtime.stopExactTerminalsForWorktree(`id:${WORKTREE}`, [PTY], {
    keepHistory: true,
    targetOnly: true
  })

describe('terminal.stopExact reaps what outlived the PTY', () => {
  beforeEach(() => {
    reap.survivors = []
    reap.calls = []
  })

  it('reaps after the stop and verifies when nothing marked is left', async () => {
    const result = await stop(runtimeWith(true))
    expect(reap.calls).toEqual([PTY])
    expect(result).toMatchObject({ stoppedPtyIds: [PTY], postStopVerified: true })
  })

  it('fails the stop (Couldn’t restart) when a marked process survives the reap', async () => {
    reap.survivors = [1654]
    await expect(stop(runtimeWith(true))).rejects.toMatchObject({
      message: 'terminal_exact_stop_failed',
      reason: 'agent_survived',
      survivorPids: [1654]
    })
  })

  it('is idempotent: a retry for a PTY whose shell is already gone still reaps, then succeeds', async () => {
    const result = await stop(runtimeWith(false))
    expect(reap.calls).toEqual([PTY])
    expect(result).toMatchObject({ stopped: 0, stoppedPtyIds: [PTY], postStopVerified: true })
  })

  it('a retry with a survivor still fails, never reports a clean stop', async () => {
    reap.survivors = [1654]
    await expect(stop(runtimeWith(false))).rejects.toMatchObject({ reason: 'agent_survived' })
  })
})
