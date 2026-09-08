import { describe, expect, it, vi } from 'vitest'
import {
  captureWindowsDescendantSnapshot,
  terminateIdentifiedWindowsProcessTree,
  verifyWindowsDescendantSnapshotExit,
  type WindowsDescendantSnapshot
} from './windows-descendant-exit-verification'

function snapshot(
  descendants: { pid: number; creationTimeMs: number }[],
  unidentifiedCount = 0
): WindowsDescendantSnapshot {
  return {
    root: { pid: 100, creationTimeMs: 5 },
    descendants,
    unidentifiedCount,
    capturedAtMs: 1_700_000_000_000
  }
}

describe('captureWindowsDescendantSnapshot', () => {
  it('does not claim an older process whose former parent PID was reused by the root', async () => {
    const olderProcess = { pid: 50244, ppid: 36084, creationTimeMs: 1788659167395 }
    const captured = await captureWindowsDescendantSnapshot(36084, {
      readTable: async () => [
        { pid: 36084, ppid: 60976, creationTimeMs: 1788733587893 },
        olderProcess
      ]
    })

    expect(captured?.descendants).toEqual([])
    await expect(
      verifyWindowsDescendantSnapshotExit(captured!, { readTable: async () => [olderProcess] })
    ).resolves.toBe('exited')
  })

  it('prunes a stale parent link and its subtree at any depth', async () => {
    const captured = await captureWindowsDescendantSnapshot(100, {
      readTable: async () => [
        { pid: 100, ppid: 1, creationTimeMs: 5 },
        { pid: 200, ppid: 100, creationTimeMs: 10 },
        { pid: 300, ppid: 200, creationTimeMs: 7 },
        { pid: 400, ppid: 300, creationTimeMs: 12 },
        { pid: 500, ppid: 100, creationTimeMs: 4 },
        { pid: 600, ppid: 500, creationTimeMs: 13 },
        { pid: 700, ppid: 200, creationTimeMs: 10 }
      ]
    })

    expect(captured?.descendants).toEqual([
      { pid: 700, creationTimeMs: 10 },
      { pid: 200, creationTimeMs: 10 }
    ])
  })

  it('keeps the root when its own parent PID was reused by a newer process', async () => {
    // The root's retained ppid now names a process created after it. Pruning the
    // root drops the whole snapshot, so its own link is never evidence about it.
    const captured = await captureWindowsDescendantSnapshot(100, {
      readTable: async () => [
        { pid: 100, ppid: 900, creationTimeMs: 5 },
        { pid: 900, ppid: 1, creationTimeMs: 50 },
        { pid: 200, ppid: 100, creationTimeMs: 7 }
      ],
      now: () => 42
    })

    expect(captured).toEqual({
      root: { pid: 100, creationTimeMs: 5 },
      descendants: [{ pid: 200, creationTimeMs: 7 }],
      unidentifiedCount: 0,
      capturedAtMs: 42
    })
  })

  it('bounds a link by the root when the claimed parent denied its creation time', async () => {
    // 300 has no creation time for a child to be compared against, so the root's
    // start is the only bound left: 350 ties with it, which a same-millisecond
    // spawn does routinely, while 360 predates the whole tree.
    const captured = await captureWindowsDescendantSnapshot(100, {
      readTable: async () => [
        { pid: 100, ppid: 1, creationTimeMs: 5 },
        { pid: 300, ppid: 100 },
        { pid: 350, ppid: 300, creationTimeMs: 5 },
        { pid: 360, ppid: 300, creationTimeMs: 2 }
      ],
      now: () => 42
    })

    expect(captured).toEqual({
      root: { pid: 100, creationTimeMs: 5 },
      descendants: [{ pid: 350, creationTimeMs: 5 }],
      unidentifiedCount: 1,
      capturedAtMs: 42
    })
  })

  it('drops an unidentified row whose parent link was pruned', async () => {
    // 250 denied its creation time, but 200's claim on the root is impossible, so
    // 250 was never in this tree: counting it would cap the verdict at
    // unverifiable over a process the root does not own.
    const captured = await captureWindowsDescendantSnapshot(100, {
      readTable: async () => [
        { pid: 100, ppid: 1, creationTimeMs: 10 },
        { pid: 200, ppid: 100, creationTimeMs: 5 },
        { pid: 250, ppid: 200 }
      ]
    })

    expect(captured?.descendants).toEqual([])
    expect(captured?.unidentifiedCount).toBe(0)
    await expect(
      verifyWindowsDescendantSnapshotExit(captured!, { readTable: async () => [] })
    ).resolves.toBe('exited')
  })

  it('walks the whole subtree and keeps only rows a later read can re-identify', async () => {
    const captured = await captureWindowsDescendantSnapshot(100, {
      // 400 is a grandchild; 300 denied a creation-time query, so no later read
      // could tell it from a recycled pid and signalling it would risk a stranger.
      readTable: vi.fn(async () => [
        { pid: 100, ppid: 1, creationTimeMs: 5 },
        { pid: 200, ppid: 100, creationTimeMs: 7 },
        { pid: 300, ppid: 100 },
        { pid: 400, ppid: 200, creationTimeMs: 9 },
        { pid: 500, ppid: 1, creationTimeMs: 11 }
      ]),
      now: () => 42
    })

    expect(captured).toEqual({
      root: { pid: 100, creationTimeMs: 5 },
      descendants: [
        { pid: 400, creationTimeMs: 9 },
        { pid: 200, creationTimeMs: 7 }
      ],
      // Seen but not re-identifiable: counted, so no later read can prove it gone.
      unidentifiedCount: 1,
      capturedAtMs: 42
    })
  })

  it('reports an unreadable or rootless table as no snapshot rather than an empty one', async () => {
    await expect(
      captureWindowsDescendantSnapshot(100, {
        readTable: vi.fn(async () => {
          throw new Error('table unavailable')
        })
      })
    ).resolves.toBeNull()
    // A snapshot without the root is stale or filtered; only an observed root
    // can authoritatively have no descendants.
    await expect(
      captureWindowsDescendantSnapshot(100, {
        readTable: vi.fn(async () => [{ pid: 999, ppid: 1, creationTimeMs: 5 }])
      })
    ).resolves.toBeNull()
  })

  it('refuses an invalid root pid', async () => {
    const readTable = vi.fn()
    await expect(captureWindowsDescendantSnapshot(0, { readTable })).resolves.toBeNull()
    expect(readTable).not.toHaveBeenCalled()
  })
})

describe('verifyWindowsDescendantSnapshotExit', () => {
  it('proves an empty tree without reading the table', async () => {
    const readTable = vi.fn()
    await expect(verifyWindowsDescendantSnapshotExit(snapshot([]), { readTable })).resolves.toBe(
      'exited'
    )
    expect(readTable).not.toHaveBeenCalled()
  })

  it('never proves a tree that held a descendant it could not identify', async () => {
    // A descendant that denied the creation-time query was seen in the table;
    // being unable to re-identify it is "could not look", never "it is gone".
    const readTable = vi.fn()
    await expect(verifyWindowsDescendantSnapshotExit(snapshot([], 1), { readTable })).resolves.toBe(
      'unverifiable'
    )
    expect(readTable).not.toHaveBeenCalled()

    // The identified sibling leaving proves nothing about the unidentified one.
    await expect(
      verifyWindowsDescendantSnapshotExit(snapshot([{ pid: 200, creationTimeMs: 7 }], 1), {
        readTable: vi.fn(async () => []),
        wait: async () => {},
        now: vi.fn().mockReturnValueOnce(0).mockReturnValue(1)
      })
    ).resolves.toBe('unverifiable')
  })

  it('reports exited once no identity-matched row remains', async () => {
    const readTable = vi
      .fn()
      .mockResolvedValueOnce([{ pid: 200, ppid: 100, creationTimeMs: 7 }])
      // The pid came back on a different process; that is a recycle, not a survivor.
      .mockResolvedValueOnce([{ pid: 200, ppid: 100, creationTimeMs: 99 }])

    await expect(
      verifyWindowsDescendantSnapshotExit(snapshot([{ pid: 200, creationTimeMs: 7 }]), {
        readTable,
        wait: async () => {},
        now: vi.fn().mockReturnValueOnce(0).mockReturnValue(1)
      })
    ).resolves.toBe('exited')
    expect(readTable).toHaveBeenCalledTimes(2)
  })

  it('reports live for a descendant still matched at the deadline', async () => {
    let clock = 0
    await expect(
      verifyWindowsDescendantSnapshotExit(snapshot([{ pid: 200, creationTimeMs: 7 }]), {
        readTable: vi.fn(async () => [{ pid: 200, ppid: 100, creationTimeMs: 7 }]),
        wait: async () => {
          clock += 100
        },
        now: () => clock,
        verifyMs: 250
      })
    ).resolves.toBe('live')
  })

  it('reports unverifiable when the table cannot be read at the deadline', async () => {
    await expect(
      verifyWindowsDescendantSnapshotExit(snapshot([{ pid: 200, creationTimeMs: 7 }]), {
        readTable: vi.fn(async () => {
          throw new Error('table unavailable')
        }),
        wait: async () => {},
        now: vi.fn().mockReturnValueOnce(0).mockReturnValue(9_999)
      })
    ).resolves.toBe('unverifiable')
  })
})

describe('terminateIdentifiedWindowsProcessTree', () => {
  it('never taskkills a replacement that reused the captured root pid', async () => {
    const terminateTree = vi.fn(async () => {})

    await expect(
      terminateIdentifiedWindowsProcessTree(
        { pid: 100, creationTimeMs: 5 },
        {
          readTable: vi.fn(async () => [{ pid: 100, ppid: 1, creationTimeMs: 99 }]),
          terminateTree
        }
      )
    ).resolves.toBe(false)
    expect(terminateTree).not.toHaveBeenCalled()
  })

  it('rechecks retained-child ownership after the identity read settles', async () => {
    const terminateTree = vi.fn(async () => {})

    await expect(
      terminateIdentifiedWindowsProcessTree(
        { pid: 100, creationTimeMs: 5 },
        {
          readTable: vi.fn(async () => [{ pid: 100, ppid: 1, creationTimeMs: 5 }]),
          ownsRoot: () => false,
          terminateTree
        }
      )
    ).resolves.toBe(false)
    expect(terminateTree).not.toHaveBeenCalled()
  })
})
