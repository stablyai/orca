import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTopologySlice } from '../../shared/terminal-topology-slice'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { TEST_LEAF_1 } from '../persistence-session-fixtures'
import {
  TerminalTopologyPublisher,
  type WorkspaceSessionOwner
} from './terminal-topology-publisher'

const WT = 'repo-1::/tmp/wt-a'
const WT_B = 'repo-1::/tmp/wt-b'

function sessionWith(worktreeIds: string[]): WorkspaceSessionState {
  const session = getDefaultWorkspaceSession()
  for (const worktreeId of worktreeIds) {
    const tabId = `tab-${worktreeId}`
    session.tabsByWorktree[worktreeId] = [
      {
        id: tabId,
        worktreeId,
        ptyId: 'pty-1',
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    session.terminalLayoutsByTabId[tabId] = {
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
    }
  }
  return session
}

function harness(initial: WorkspaceSessionState) {
  let session = initial
  const readOwners = vi.fn(
    () =>
      new Map<string, WorkspaceSessionOwner>(
        Object.keys(session.tabsByWorktree).map((worktreeId) => [
          worktreeId,
          { hostId: 'local', session }
        ])
      )
  )
  const pushes: TerminalTopologySlice[] = []
  let sinkError: Error | null = null
  const publisher = new TerminalTopologyPublisher(readOwners, (slice) => {
    if (sinkError) {
      throw sinkError
    }
    pushes.push(slice)
  })
  // The first settle publishes the starting topology; tests then observe only later changes.
  publisher.markDirty()
  publisher.settle()
  pushes.length = 0
  return {
    publisher,
    pushes,
    readOwners,
    get session() {
      return session
    },
    replace(next: WorkspaceSessionState) {
      session = next
    },
    failSink(error: Error) {
      sinkError = error
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TerminalTopologyPublisher', () => {
  it('publishes every worktree on the first flush', () => {
    const pushes: TerminalTopologySlice[] = []
    const session = sessionWith([WT, WT_B])
    const publisher = new TerminalTopologyPublisher(
      () =>
        new Map<string, WorkspaceSessionOwner>([
          [WT, { hostId: 'local', session }],
          [WT_B, { hostId: 'local', session }]
        ]),
      (slice) => pushes.push(slice)
    )

    publisher.markDirty()
    publisher.flush()

    expect(pushes.map((slice) => [slice.worktreeId, slice.publishSeq])).toEqual([
      [WT, 1],
      [WT_B, 2]
    ])
  })

  it('pushes only the worktree whose topology changed, once per burst', async () => {
    const h = harness(sessionWith([WT, WT_B]))
    const next = structuredClone(h.session)
    next.terminalLayoutsByTabId[`tab-${WT}`]!.ptyIdsByLeafId = { [TEST_LEAF_1]: 'pty-2' }
    h.replace(next)
    h.readOwners.mockClear()

    h.publisher.markDirty()
    h.publisher.markDirty()
    h.publisher.markDirty()
    expect(h.pushes).toEqual([])
    await Promise.resolve()

    expect(h.readOwners).toHaveBeenCalledTimes(1)
    expect(h.pushes.map((slice) => [slice.worktreeId, slice.publishSeq])).toEqual([[WT, 3]])
    expect(h.pushes[0]!.layouts[`tab-${WT}`]!.ptyIdsByLeafId).toEqual({ [TEST_LEAF_1]: 'pty-2' })
  })

  it('sees an in-place edit and ignores an equal rewrite or a presentation-only change', async () => {
    const h = harness(sessionWith([WT]))
    h.replace({ ...structuredClone(h.session) })
    h.session.tabsByWorktree[WT]![0]!.customTitle = 'renamed'
    h.publisher.markDirty()
    await Promise.resolve()
    expect(h.pushes).toEqual([])

    // Same object identity, as the ssh-binding cleanup writes.
    h.session.tabsByWorktree[WT]![0]!.ptyId = null
    h.publisher.markDirty()
    await Promise.resolve()
    expect(h.pushes.map((slice) => slice.tabs[0]!.ptyId)).toEqual([null])
  })

  it('publishes an empty slice once when a worktree loses all rows', async () => {
    const h = harness(sessionWith([WT, WT_B]))
    h.replace(sessionWith([WT_B]))

    h.publisher.markDirty()
    await Promise.resolve()
    h.publisher.markDirty()
    await Promise.resolve()

    expect(h.pushes).toEqual([
      {
        hostId: 'local',
        worktreeId: WT,
        publishSeq: 3,
        revision: 0,
        tabs: [],
        layouts: {},
        sleeping: {}
      }
    ])
  })

  it('settle flushes synchronously so a reply names a push that already went out', () => {
    const h = harness(sessionWith([WT]))
    h.replace(sessionWith([WT, WT_B]))
    h.publisher.markDirty()

    const seq = h.publisher.settle(WT_B)

    expect(h.pushes.map((slice) => slice.publishSeq)).toEqual([seq])
    expect(h.publisher.settle(WT)).toBe(1)
    expect(h.publisher.settle()).toBe(seq)
  })

  it('keeps publishSeq monotonic across pushes', async () => {
    const h = harness(sessionWith([WT]))
    const seqs: number[] = [h.publisher.settle(WT)]
    for (const ptyId of ['a', 'b', 'c']) {
      const next = structuredClone(h.session)
      next.tabsByWorktree[WT]![0]!.ptyId = ptyId
      h.replace(next)
      h.publisher.markDirty()
      await Promise.resolve()
      seqs.push(h.publisher.settle(WT))
    }

    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('logs a throwing sink or projection once without throwing to the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness(sessionWith([WT]))
    h.failSink(new Error('frame gone'))
    h.replace(sessionWith([WT, WT_B]))
    h.publisher.markDirty()
    await Promise.resolve()
    h.readOwners.mockImplementation(() => {
      throw new Error('store unavailable')
    })
    h.publisher.markDirty()

    expect(() => h.publisher.settle(WT)).not.toThrow()
    expect(h.readOwners).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
