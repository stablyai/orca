import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

vi.mock('electron', () => ({
  app: {
    getAppMetrics: () => []
  }
}))

const { execMock, listRegisteredPtysMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string }) => void) =>
    execMock(cmd, opts, cb)
}))

vi.mock('./pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

async function loadCollector() {
  vi.resetModules()
  return await import('./collector')
}

const emptyStore = {
  getWorktreeMeta: () => undefined,
  getRepo: () => undefined
} as unknown as Store

describe('parsePsOutput', () => {
  it('parses a well-formed listing into rows', async () => {
    const { parsePsOutput } = await loadCollector()
    const stdout = ['  1 0 0.1 1024', '123 1 5.5 2048', '456 123 0.0 512'].join('\n')

    const rows = parsePsOutput(stdout)

    expect(rows).toEqual([
      { pid: 1, ppid: 0, cpu: 0.1, memory: 1024 * 1024 },
      { pid: 123, ppid: 1, cpu: 5.5, memory: 2048 * 1024 },
      { pid: 456, ppid: 123, cpu: 0, memory: 512 * 1024 }
    ])
  })

  it('parses dot-decimal cpu values (LC_ALL=C contract)', async () => {
    const { parsePsOutput } = await loadCollector()
    // Why: the enumerator forces LC_ALL=C so ps emits dots, not commas.
    // If that env override is removed, de_DE systems emit "12,5" and
    // parseFloat silently returns 12. This test pins the parser's
    // assumption so the regression is caught here, not in the field.
    const rows = parsePsOutput('10 1 12.5 1024')
    expect(rows[0].cpu).toBe(12.5)
  })

  it('skips blank lines and rows with too few fields', async () => {
    const { parsePsOutput } = await loadCollector()
    const rows = parsePsOutput('\n  \n10 1 0.0\n20 1 0.0 512\n')
    expect(rows).toEqual([{ pid: 20, ppid: 1, cpu: 0, memory: 512 * 1024 }])
  })

  it('skips rows whose pid or ppid fail to parse', async () => {
    const { parsePsOutput } = await loadCollector()
    const rows = parsePsOutput(['abc 1 0.0 100', '10 xyz 0.0 100', '20 1 0.0 100'].join('\n'))
    expect(rows.map((r) => r.pid)).toEqual([20])
  })

  it('clamps negative or NaN cpu/memory to 0', async () => {
    const { parsePsOutput } = await loadCollector()
    const rows = parsePsOutput('10 1 -5 -100')
    expect(rows[0].cpu).toBe(0)
    expect(rows[0].memory).toBe(0)
  })
})

describe('parseWmicOutput', () => {
  it('emits one row per blank-line-delimited stanza', async () => {
    const { parseWmicOutput } = await loadCollector()
    const stdout = [
      'ParentProcessId=1',
      'ProcessId=100',
      'WorkingSetSize=2048',
      '',
      'ParentProcessId=100',
      'ProcessId=200',
      'WorkingSetSize=1024',
      ''
    ].join('\r\n')

    const rows = parseWmicOutput(stdout)

    expect(rows).toEqual([
      { pid: 100, ppid: 1, cpu: 0, memory: 2048 },
      { pid: 200, ppid: 100, cpu: 0, memory: 1024 }
    ])
  })

  it('flushes the final stanza even without a trailing blank line', async () => {
    const { parseWmicOutput } = await loadCollector()
    const rows = parseWmicOutput('ProcessId=100\nParentProcessId=1\nWorkingSetSize=512')
    expect(rows).toEqual([{ pid: 100, ppid: 1, cpu: 0, memory: 512 }])
  })

  it('skips stanzas missing pid or ppid', async () => {
    const { parseWmicOutput } = await loadCollector()
    // Why: wmic occasionally emits a stanza with only WorkingSetSize set
    // (e.g. a process that exited mid-query). Dropping such rows avoids
    // injecting ghost zero-pid entries into the index.
    const stdout = ['WorkingSetSize=999', '', 'ProcessId=100', 'ParentProcessId=1'].join('\n')
    const rows = parseWmicOutput(stdout)
    expect(rows).toEqual([{ pid: 100, ppid: 1, cpu: 0, memory: 0 }])
  })

  it('ignores lines without an equals separator', async () => {
    const { parseWmicOutput } = await loadCollector()
    const rows = parseWmicOutput(['garbage line', 'ProcessId=5', 'ParentProcessId=1'].join('\n'))
    expect(rows).toEqual([{ pid: 5, ppid: 1, cpu: 0, memory: 0 }])
  })
})

describe('collectSubtree', () => {
  function makeIndex(rows: { pid: number; ppid: number }[]) {
    const byPid = new Map<number, { pid: number; ppid: number; cpu: number; memory: number }>()
    const childrenOf = new Map<number, number[]>()
    for (const r of rows) {
      byPid.set(r.pid, { ...r, cpu: 0, memory: 0 })
      const kids = childrenOf.get(r.ppid)
      if (kids) {
        kids.push(r.pid)
      } else {
        childrenOf.set(r.ppid, [r.pid])
      }
    }
    return { byPid, childrenOf }
  }

  it('walks every descendant of the root inclusive', async () => {
    const { collectSubtree } = await loadCollector()
    const index = makeIndex([
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 1 },
      { pid: 4, ppid: 2 },
      { pid: 99, ppid: 0 } // unrelated branch
    ])

    const pids = collectSubtree(index, 1).sort((a, b) => a - b)

    expect(pids).toEqual([1, 2, 3, 4])
  })

  it('does not revisit pids when cycles are present', async () => {
    const { collectSubtree } = await loadCollector()
    // Why: the ppid graph is untrusted — a buggy `ps` snapshot (or a
    // wrapped/reparented process) could present a cycle. collectSubtree
    // must terminate and not double-count the same pid.
    const index = makeIndex([
      { pid: 1, ppid: 2 },
      { pid: 2, ppid: 1 }
    ])

    const pids = collectSubtree(index, 1).sort((a, b) => a - b)

    expect(pids).toEqual([1, 2])
  })

  it('returns only pids that exist in byPid', async () => {
    const { collectSubtree } = await loadCollector()
    // Why: childrenOf may reference a pid that no longer has a row (it
    // exited between sampling its parent and sampling itself). We list
    // those as "walked" but do not fabricate a row for them.
    const index = {
      byPid: new Map([[1, { pid: 1, ppid: 0, cpu: 0, memory: 0 }]]),
      childrenOf: new Map([[1, [2]]])
    }

    expect(collectSubtree(index, 1)).toEqual([1])
  })
})

describe('collectMemorySnapshot', () => {
  beforeEach(() => {
    execMock.mockReset()
    listRegisteredPtysMock.mockReset()
    listRegisteredPtysMock.mockReturnValue([])
  })

  function mockPsResponse(stdout: string) {
    execMock.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout, stderr: '' }))
  }

  it('coalesces concurrent callers onto a single in-flight sweep', async () => {
    // Why: the collector exists in part to prevent a burst of renderer
    // polls from spawning overlapping `ps` children. If a regression ever
    // removes the `inflight` guard, this test catches it without needing
    // to measure real process spawns.
    mockPsResponse('1 0 0 1024')
    const { collectMemorySnapshot } = await loadCollector()

    const [a, b, c] = await Promise.all([
      collectMemorySnapshot(emptyStore),
      collectMemorySnapshot(emptyStore),
      collectMemorySnapshot(emptyStore)
    ])

    expect(execMock).toHaveBeenCalledTimes(1)
    // All three callers see the same snapshot object (same promise).
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('starts a fresh sweep after the prior one resolves', async () => {
    mockPsResponse('1 0 0 1024')
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    await collectMemorySnapshot(emptyStore)

    expect(execMock).toHaveBeenCalledTimes(2)
  })

  it('attributes a process shared by two PTYs to the first registrant only', async () => {
    // Why: when two PTYs share an ancestor (e.g. a supervisor or a shell
    // that re-execed), a naive per-PTY subtree walk would double-count
    // the shared process. The `claimed` set in runSnapshot enforces
    // first-wins attribution in registration order. This test pins that
    // invariant — if the dedupe is lost, the totals balloon.
    mockPsResponse(
      [
        '100 1 0 1024', // shared ancestor of both PTYs
        '101 100 0 512', // pty A's only unique child
        '102 100 0 256' // pty B's only unique child
      ].join('\n')
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-a',
        worktreeId: 'repo-1::/wt/a',
        sessionId: 's-a',
        paneKey: 'p-a',
        pid: 100 // sees {100, 101, 102}
      },
      {
        ptyId: 'pty-b',
        worktreeId: 'repo-1::/wt/b',
        sessionId: 's-b',
        paneKey: 'p-b',
        pid: 100 // also rooted at 100, but every pid is already claimed
      }
    ])

    const { collectMemorySnapshot } = await loadCollector()
    const snap = await collectMemorySnapshot(emptyStore)

    const byWt = new Map(snap.worktrees.map((w) => [w.worktreeId, w]))
    const a = byWt.get('repo-1::/wt/a')
    const b = byWt.get('repo-1::/wt/b')

    // pty-a claims all three pids (1024 + 512 + 256 KiB).
    expect(a?.memory).toBe((1024 + 512 + 256) * 1024)
    // pty-b gets zero because everything it would walk is already claimed.
    expect(b?.memory).toBe(0)
    // And the overall session memory equals the unique sum, not the
    // double-walked sum — this is the actual regression we care about.
    expect(snap.totalMemory).toBe((1024 + 512 + 256) * 1024)
  })

  it('routes PTYs with no worktreeId into the orphan bucket', async () => {
    mockPsResponse('50 1 0 2048')
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-orphan',
        worktreeId: null,
        sessionId: null,
        paneKey: null,
        pid: 50
      }
    ])

    const { collectMemorySnapshot } = await loadCollector()
    const snap = await collectMemorySnapshot(emptyStore)

    expect(snap.worktrees).toHaveLength(1)
    expect(snap.worktrees[0].worktreeId).toBe('__orphan__')
    expect(snap.worktrees[0].memory).toBe(2048 * 1024)
  })

  it('returns an empty snapshot when ps fails', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => cb(new Error('ps blew up'), { stdout: '' }))
    listRegisteredPtysMock.mockReturnValue([])

    const { collectMemorySnapshot } = await loadCollector()
    const snap = await collectMemorySnapshot(emptyStore)

    // ps failure should not surface as a rejected promise or crash the
    // renderer; the collector swallows and returns zeros so the UI can
    // render an empty state.
    expect(snap.worktrees).toEqual([])
    expect(snap.totalMemory).toBe(0)
  })
})
