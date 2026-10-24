import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'

const WORKTREE = 'repo::/tmp/exact-stop'
const PTY = `${WORKTREE}@@terminal`
const TAB = '10000000-0000-4000-8000-000000000001'
const LEAF = '10000000-0000-4000-8000-000000000002'
const INCARNATION = '10000000-0000-4000-8000-000000000003'

class ExactStopRuntime extends OrcaRuntimeService {
  override resolveWorktreeSelector(selector: string) {
    return super.resolveWorktreeSelector(selector)
  }

  override getResolvedWorktreeMap() {
    return super.getResolvedWorktreeMap()
  }

  async overlappingInventory(): Promise<unknown> {
    return this.refreshPtyWorktreeRecordsWithControllerInventory(
      [...(await this.getResolvedWorktreeMap()).values()],
      null,
      undefined,
      null
    )
  }
}

function folderWorktree() {
  const git = {
    path: '/tmp/exact-stop',
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
    displayName: 'exact-stop',
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

describe('terminal.stopExact post-stop verification', () => {
  it('verifies a confirmed stop even when an overlapping inventory voids its first check', async () => {
    const runtime = new ExactStopRuntime()
    const worktree = folderWorktree()
    vi.spyOn(runtime, 'resolveWorktreeSelector').mockResolvedValue(worktree)
    vi.spyOn(runtime, 'getResolvedWorktreeMap').mockResolvedValue(new Map([[WORKTREE, worktree]]))
    let stopped = false
    let overlapped: Promise<unknown> | null = null
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
      listProcesses: async () => {
        if (!stopped) {
          return [{ id: PTY, incarnationId: INCARNATION, cwd: worktree.path, title: 'terminal' }]
        }
        // Why: the exit's own session republish starts a newer inventory mid-check, as on a loaded host.
        overlapped ??= runtime.overlappingInventory()
        return []
      }
    })
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

    const result = await runtime.stopExactTerminalsForWorktree(`id:${WORKTREE}`, [PTY], {
      keepHistory: true,
      targetOnly: true
    })
    await overlapped

    expect(overlapped).not.toBeNull()
    expect(result).toMatchObject({ stoppedPtyIds: [PTY], postStopVerified: true })
  })
})
