import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE = 'repo::/tmp/graph-exit'
const TAB = '10000000-0000-4000-8000-000000000001'
const LEAF = '10000000-0000-4000-8000-000000000002'
const PTY = `${WORKTREE}@@terminal`
const FIRST = '10000000-0000-4000-8000-000000000003'
const NEXT = '10000000-0000-4000-8000-000000000004'

class ExitAuthorityRuntime extends OrcaRuntimeService {
  override resolveWorktreeSelector(selector: string) {
    return super.resolveWorktreeSelector(selector)
  }

  override getResolvedWorktreeMap() {
    return super.getResolvedWorktreeMap()
  }

  capture(id = PTY) {
    const pty = this.ptysById.get(id)
    return { connected: pty?.connected, incarnationId: pty?.incarnationId }
  }

  get verdictCount(): number {
    return this.ptyLivenessVerdictByPtyId.size
  }

  dropRecord(id = PTY): void {
    this.dropDisconnectedPtyRecord(id)
  }

  history() {
    return {
      surfaces: this.mobileSessionTabsByWorktree.get(WORKTREE)?.tabs.length,
      leaves: this.getLeavesForPty(PTY).map((leaf) => ({
        connected: leaf.connected,
        writable: leaf.writable
      })),
      model: this.headlessTerminals.has(PTY)
    }
  }
}

function graph(
  runtime: OrcaRuntimeService,
  ptyId: string | null = PTY,
  snapshotVersion?: number
): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId: TAB, worktreeId: WORKTREE, title: 'terminal', activeLeafId: LEAF, layout: null }
    ],
    leaves: [{ tabId: TAB, worktreeId: WORKTREE, leafId: LEAF, paneRuntimeId: 1, ptyId }],
    ...(snapshotVersion === undefined
      ? {}
      : {
          mobileSessionTabs: [
            {
              worktree: WORKTREE,
              publicationEpoch: 'renderer:retained-history',
              snapshotVersion,
              activeGroupId: null,
              activeTabId: `${TAB}::${LEAF}`,
              activeTabType: 'terminal' as const,
              tabs: [
                {
                  type: 'terminal' as const,
                  id: `${TAB}::${LEAF}`,
                  parentTabId: TAB,
                  leafId: LEAF,
                  ...(ptyId ? { ptyId } : {}),
                  title: 'Terminal',
                  isActive: true
                }
              ]
            }
          ]
        })
  })
}

function register(runtime: OrcaRuntimeService, incarnationId = FIRST): void {
  runtime.registerPty(PTY, WORKTREE, null, { tabId: TAB, leafId: LEAF, incarnationId })
}

describe('host exit authority over queued renderer graphs', () => {
  it('keeps exact-stop history addressable through a changed snapshot before binding clears', async () => {
    const runtime = new ExitAuthorityRuntime()
    const git = {
      path: '/tmp/graph-exit',
      head: 'abc',
      branch: 'main',
      isBare: false,
      isMainWorktree: false
    }
    const worktree = {
      ...git,
      git,
      id: WORKTREE,
      repoId: 'repo',
      displayName: 'graph-exit',
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
    const resolve = vi.spyOn(runtime, 'resolveWorktreeSelector').mockResolvedValue(worktree)
    const map = vi
      .spyOn(runtime, 'getResolvedWorktreeMap')
      .mockResolvedValue(new Map([[WORKTREE, worktree]]))
    let stopped = false
    let finishStop!: () => void
    const gate = new Promise<void>((done) => {
      finishStop = done
    })
    const stop = vi.fn(async () => {
      runtime.onPtyExit(PTY, 0, FIRST, { providerExitObserved: true })
      stopped = true
      await gate
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait: stop,
      getForegroundProcess: async () => null,
      hasPty: () => !stopped,
      listProcesses: async () =>
        stopped ? [] : [{ id: PTY, incarnationId: FIRST, cwd: worktree.path, title: 'terminal' }]
    })
    let pending: Promise<unknown> | undefined
    try {
      register(runtime)
      graph(runtime, PTY, 1)
      pending = runtime.stopExactTerminalsForWorktree(`id:${WORKTREE}`, [PTY], {
        keepHistory: true,
        targetOnly: true
      })
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
      graph(runtime, PTY, 2)
      expect(runtime.history()).toEqual({
        surfaces: 1,
        leaves: [{ connected: false, writable: false }],
        model: false
      })
      finishStop()
      await expect(pending).resolves.toMatchObject({ postStopVerified: true })
      graph(runtime, null, 3)
      expect(runtime.history().surfaces).toBe(1)
    } finally {
      finishStop()
      await pending
      resolve.mockRestore()
      map.mockRestore()
      runtime.onPtyExit(PTY, 0, FIRST)
    }
  })

  it.each([0, -1])('retains a physical exit certificate after record pruning, code=%s', (code) => {
    const runtime = new ExitAuthorityRuntime()
    register(runtime)
    runtime.dropRecord()
    runtime.onPtyExit(PTY, code, FIRST, { providerExitObserved: true })
    graph(runtime)
    expect(runtime.capture().connected).toBeUndefined()
    expect(runtime.getPtyLivenessVerdict(PTY)).toEqual({ status: 'exited' })
  })

  it('admits a new renderer pane without inventing a host verdict', () => {
    const runtime = new ExitAuthorityRuntime()
    graph(runtime)
    expect(runtime.capture().connected).toBe(true)
    expect(runtime.getPtyLivenessVerdict(PTY)).toBeNull()
  })

  it('admits a registered successor and ignores the predecessor exit', () => {
    const runtime = new ExitAuthorityRuntime()
    register(runtime)
    runtime.onPtyExit(PTY, 0, FIRST)
    register(runtime, NEXT)
    runtime.onPtyExit(PTY, 0, FIRST)
    graph(runtime)
    expect(runtime.capture()).toEqual({ connected: true, incarnationId: NEXT })
    expect(runtime.getPtyLivenessVerdict(PTY)).toBeNull()
  })

  it('admits a same-ID spawn before its registration commits', () => {
    const runtime = new ExitAuthorityRuntime()
    register(runtime)
    runtime.onPtyExit(PTY, 0, FIRST)
    runtime.onPtySpawned(PTY, NEXT)
    graph(runtime)
    expect(runtime.capture()).toEqual({ connected: true, incarnationId: NEXT })
    expect(runtime.getPtyLivenessVerdict(PTY)).toBeNull()
  })

  it('allows owning inventory to prove the same ID live again', async () => {
    const runtime = new ExitAuthorityRuntime()
    register(runtime)
    runtime.onPtyExit(PTY, 0, FIRST)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: PTY, incarnationId: NEXT, cwd: '', title: 'terminal' }]
    })
    await runtime.listTerminals()
    graph(runtime)
    expect(runtime.capture()).toEqual({ connected: true, incarnationId: NEXT })
    expect(runtime.getPtyLivenessVerdict(PTY)?.status).toBe('live')
  })

  it('keeps an SSH disconnect unverifiable and admissible', () => {
    const runtime = new ExitAuthorityRuntime()
    const id = 'ssh:target@@terminal'
    runtime.registerPty(id, WORKTREE, 'target', { tabId: TAB, leafId: LEAF, incarnationId: FIRST })
    runtime.onPtyExit(id, -1, FIRST)
    graph(runtime, id)
    expect(runtime.getPtyLivenessVerdict(id)?.status).toBe('unverifiable')
    expect(runtime.capture(id).connected).toBe(true)
  })

  it('does not promote an unverified local stop to an exit certificate', () => {
    const runtime = new ExitAuthorityRuntime()
    runtime.registerPty(PTY, WORKTREE)
    runtime.onPtyExit(PTY, -1, FIRST)
    runtime.markPtyLivenessUnverifiable(PTY, 'stop unverified')
    graph(runtime)
    expect(runtime.getPtyLivenessVerdict(PTY)?.status).toBe('unverifiable')
    expect(runtime.capture().connected).toBe(true)
  })

  it('bounds certificates for exits whose PTY records are already gone', () => {
    const runtime = new ExitAuthorityRuntime()
    for (let index = 0; index < 1_000; index++) {
      runtime.onPtyExit(`${PTY}-${index}`, 0)
    }
    expect(runtime.verdictCount).toBe(256)
    expect(runtime.getPtyLivenessVerdict(`${PTY}-0`)).toBeNull()
    expect(runtime.getPtyLivenessVerdict(`${PTY}-999`)).toEqual({ status: 'exited' })
  })
})
