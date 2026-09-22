import { afterEach, describe, expect, it, vi } from 'vitest'
import { sweepSessionDescendants } from './pty-session-descendant-sweep'
import {
  createPtySessionProcessIdentity,
  markPtySessionRootExited,
  observePtySessionTerminal,
  recordPtySessionGroups
} from './pty-session-identity'
import type { ProcessTableCapture, ProcessTableRow } from './pty-descendant-termination'
import { observeLiveSessionProcessIdentities } from './daemon/terminal-host-session-identity-observation'
import { notifyProcessTableCapture } from '../shared/process-table-capture-observers'

const DARWIN: NodeJS.Platform = 'darwin'
const BORN = 'Mon Jul 13 12:54:47 2026'
const OWNED_AT_MS = Date.parse('Mon Jul 13 12:54:55 2026')
const EXIT_AT_MS = Date.parse('Mon Jul 13 12:55:00 2026')
const CAPTURED_AT_MS = Date.parse('Mon Jul 13 12:56:00 2026')

function row(pid: number, ppid: number, pgid: number): ProcessTableRow {
  return { pid, ppid, pgid, startedAt: BORN }
}

function capture(rows: ProcessTableRow[]): ProcessTableCapture {
  return { rows, capturedAtMs: CAPTURED_AT_MS }
}

function exitedIdentity(pgids: number[] = [777]) {
  const identity = createPtySessionProcessIdentity({ rootPid: 500, slavePath: '/dev/ttys003' })
  identity.rootStartedAt = BORN
  recordPtySessionGroups(identity, pgids, OWNED_AT_MS)
  markPtySessionRootExited(identity, EXIT_AT_MS)
  return identity
}

function sweepHarness(tables: ProcessTableCapture[]) {
  const signals: string[] = []
  const readTable = vi.fn(async () => tables.shift() ?? capture([]))
  return {
    signals,
    readTable,
    deps: {
      readTable,
      readTtyTable: async () => null,
      sendSignal: (pid: number, signal: NodeJS.Signals) => signals.push(`${signal} ${pid}`),
      // Every recorded group still has a member unless a test says otherwise.
      probeGroup: () => true,
      platform: DARWIN,
      selfPid: 900
    }
  }
}

describe('sweepSessionDescendants', () => {
  afterEach(() => vi.useRealTimers())

  it('signals each verified member of a recorded group, never the group id, then reports them gone', async () => {
    vi.useFakeTimers()
    const harness = sweepHarness([capture([row(4767, 1, 777), row(4794, 4767, 777)])])
    const pending = sweepSessionDescendants(exitedIdentity(), harness.deps)
    await vi.advanceTimersByTimeAsync(500)

    await expect(pending).resolves.toBe('exited')
    expect(harness.signals).toEqual(['SIGTERM 4767', 'SIGTERM 4794'])
  })

  it('escalates a survivor to SIGKILL only after the grace window', async () => {
    vi.useFakeTimers()
    const survivor = capture([row(4767, 1, 777)])
    const harness = sweepHarness(Array.from({ length: 40 }, () => survivor))
    const pending = sweepSessionDescendants(exitedIdentity(), {
      ...harness.deps,
      graceMs: 400,
      verifyMs: 800
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(harness.signals).not.toContain('SIGKILL 4767')

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toBe('live')
    expect(harness.signals).toContain('SIGKILL 4767')
  })

  it('re-targets each round, so a process forked mid-sweep is signalled too', async () => {
    vi.useFakeTimers()
    const harness = sweepHarness([
      capture([row(4767, 1, 777)]),
      capture([row(4767, 1, 777), row(9100, 4767, 777)]),
      capture([])
    ])
    const pending = sweepSessionDescendants(exitedIdentity(), harness.deps)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(pending).resolves.toBe('exited')
    expect(harness.signals).toContain('SIGTERM 9100')
  })

  it('gives a pid whose identity changed a fresh SIGTERM before any force-kill', async () => {
    vi.useFakeTimers()
    const recycled: ProcessTableRow = {
      pid: 4767,
      ppid: 1,
      pgid: 777,
      startedAt: 'Mon Jul 13 12:55:50 2026'
    }
    const harness = sweepHarness([
      capture([row(4767, 1, 777)]),
      ...Array.from({ length: 20 }, () => capture([recycled]))
    ])
    const pending = sweepSessionDescendants(exitedIdentity(), {
      ...harness.deps,
      graceMs: 0,
      verifyMs: 500
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await pending

    const terms = harness.signals.filter((entry) => entry === 'SIGTERM 4767')
    expect(terms.length).toBeGreaterThanOrEqual(2)
    // The first volley answered a different process; this identity is asked to stop first.
    expect(harness.signals.indexOf('SIGKILL 4767')).toBeGreaterThan(
      harness.signals.lastIndexOf('SIGTERM 4767')
    )
  })

  it('never force-kills a pid born in the second the table was captured', async () => {
    vi.useFakeTimers()
    // ps reports whole seconds, so this identity cannot be told from a pid reused inside it.
    const birthSecond: ProcessTableRow = {
      pid: 4767,
      ppid: 1,
      pgid: 777,
      startedAt: 'Mon Jul 13 12:56:00 2026'
    }
    const harness = sweepHarness(Array.from({ length: 20 }, () => capture([birthSecond])))
    const pending = sweepSessionDescendants(exitedIdentity(), {
      ...harness.deps,
      graceMs: 0,
      verifyMs: 500
    })
    await vi.advanceTimersByTimeAsync(1_000)

    await pending
    expect(harness.signals).not.toContain('SIGKILL 4767')
  })

  it('reports an unreadable process table as unverifiable, never as exited', async () => {
    vi.useFakeTimers()
    const harness = sweepHarness([])
    const pending = sweepSessionDescendants(exitedIdentity(), {
      ...harness.deps,
      readTable: vi.fn(async () => {
        throw new Error('ps failed')
      }),
      verifyMs: 300
    })
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(pending).resolves.toBe('unverifiable')
  })

  it('does nothing on Windows, where the pty job object owns the tree', async () => {
    const harness = sweepHarness([capture([row(4767, 1, 777)])])
    await expect(
      sweepSessionDescendants(exitedIdentity(), { ...harness.deps, platform: 'win32' })
    ).resolves.toBe('exited')
    expect(harness.readTable).not.toHaveBeenCalled()
  })

  it('reads nothing for a session that never recorded a terminal or a group', async () => {
    const identity = createPtySessionProcessIdentity({ rootPid: 500 })
    markPtySessionRootExited(identity, EXIT_AT_MS)
    const harness = sweepHarness([capture([row(4767, 1, 777)])])

    await expect(sweepSessionDescendants(identity, harness.deps)).resolves.toBe('exited')
    expect(harness.readTable).not.toHaveBeenCalled()
  })

  it('settles a session whose terminal is empty without reading the whole host table', async () => {
    const harness = sweepHarness([capture([row(4767, 1, 777)])])

    await expect(
      sweepSessionDescendants(exitedIdentity([]), {
        ...harness.deps,
        readTtyTable: async () => capture([])
      })
    ).resolves.toBe('exited')
    expect(harness.readTable).not.toHaveBeenCalled()
  })

  it('still reads the host table when something remains on the terminal', async () => {
    vi.useFakeTimers()
    const harness = sweepHarness([capture([])])
    const pending = sweepSessionDescendants(exitedIdentity([]), {
      ...harness.deps,
      readTtyTable: async () => capture([row(4767, 1, 4767)])
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await pending

    expect(harness.readTable).toHaveBeenCalled()
  })

  it("settles a natural exit whose only group is the root's, now empty, with one terminal read", async () => {
    const identity = createPtySessionProcessIdentity({ rootPid: 500, slavePath: '/dev/ttys003' })
    identity.rootStartedAt = BORN
    recordPtySessionGroups(identity, [500], OWNED_AT_MS)
    markPtySessionRootExited(identity, EXIT_AT_MS)
    const harness = sweepHarness([capture([row(4767, 1, 777)])])
    const readTtyTable = vi.fn(async () => capture([]))
    const probeGroup = vi.fn(() => false)

    await expect(
      sweepSessionDescendants(identity, { ...harness.deps, readTtyTable, probeGroup })
    ).resolves.toBe('exited')
    expect(probeGroup).toHaveBeenCalledWith(500)
    expect(readTtyTable).toHaveBeenCalledTimes(1)
    expect(harness.readTable).not.toHaveBeenCalled()
  })

  it('reads the whole host table when a recorded group still has a member', async () => {
    vi.useFakeTimers()
    const harness = sweepHarness([capture([row(4767, 1, 777)])])
    const readTtyTable = vi.fn(async () => capture([]))
    const pending = sweepSessionDescendants(exitedIdentity(), { ...harness.deps, readTtyTable })
    await vi.advanceTimersByTimeAsync(10_000)
    await pending

    expect(harness.readTable).toHaveBeenCalled()
    expect(harness.signals).toContain('SIGTERM 4767')
  })

  it('reads the session terminal once, not every round', async () => {
    vi.useFakeTimers()
    const survivor = capture([row(4767, 1, 777)])
    const harness = sweepHarness(Array.from({ length: 20 }, () => survivor))
    const readTtyTable = vi.fn(async () => capture([row(4767, 1, 777)]))
    const pending = sweepSessionDescendants(exitedIdentity(), {
      ...harness.deps,
      readTtyTable,
      verifyMs: 800
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await pending

    expect(harness.readTable.mock.calls.length).toBeGreaterThan(2)
    expect(readTtyTable).toHaveBeenCalledTimes(1)
  })
})

describe('sweepSessionDescendants from groups learned by live observation', () => {
  afterEach(() => vi.useRealTimers())

  const SPAWNED_AT_MS = Date.parse('Mon Jul 13 12:50:00 2026')
  const JOB_SEEN_AT_MS = Date.parse('Mon Jul 13 12:52:00 2026')
  const STRANGER_BORN = 'Mon Jul 13 12:58:00 2026'
  const SWEPT_AT_MS = Date.parse('Mon Jul 13 13:00:00 2026')
  const liveRow = (
    pid: number,
    ppid: number,
    pgid: number,
    startedAt = 'Mon Jul 13 12:49:59 2026'
  ) => ({
    pid,
    ppid,
    pgid,
    startedAt
  })

  /**
   * Drives a session the way a live TerminalHost does: its own terminal read
   * after spawn, then the shared host captures Orca already takes, while the
   * shell's backgrounded job sits in group 610.
   */
  function sessionThatSawJob610(captures: (readonly ProcessTableRow[])[]) {
    const identity = createPtySessionProcessIdentity({ rootPid: 500, slavePath: '/dev/ttys003' })
    const session = { isAlive: true, processIdentity: identity }
    const stop = observeLiveSessionProcessIdentities(new Map([['s', session]]))
    try {
      observePtySessionTerminal(identity, [liveRow(500, 400, 500)], SPAWNED_AT_MS)
      for (const rows of captures) {
        notifyProcessTableCapture(() => rows, JOB_SEEN_AT_MS)
      }
    } finally {
      stop()
    }
    session.isAlive = false
    markPtySessionRootExited(identity, EXIT_AT_MS)
    return identity
  }

  const WITH_JOB = [liveRow(500, 400, 500), liveRow(610, 500, 610), liveRow(611, 610, 610)]

  async function sweepWith(
    identity: ReturnType<typeof createPtySessionProcessIdentity>,
    rows: ProcessTableRow[]
  ) {
    vi.useFakeTimers()
    const harness = sweepHarness([{ rows, capturedAtMs: SWEPT_AT_MS }])
    const pending = sweepSessionDescendants(identity, harness.deps)
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    return harness.signals
  }

  it('reaps the job the live tree was seen to own', async () => {
    const identity = sessionThatSawJob610([WITH_JOB])
    expect([...identity.ownedGroups.keys()]).toContain(610)

    // The shell is gone and the job reparented to pid 1.
    const signals = await sweepWith(identity, [liveRow(610, 1, 610), liveRow(611, 610, 610)])

    expect(signals).toEqual(['SIGTERM 610', 'SIGTERM 611'])
  })

  it('leaves alone a stranger that took the group id after the job was gone', async () => {
    const identity = sessionThatSawJob610([WITH_JOB])

    // Another pane's process now leads a new group 610, born after the session last owned it.
    const signals = await sweepWith(identity, [
      liveRow(610, 1, 610, STRANGER_BORN),
      liveRow(612, 610, 610, STRANGER_BORN)
    ])

    expect(signals).toEqual([])
  })

  it('leaves alone a later member of a leaderless group the session no longer owns', async () => {
    const identity = sessionThatSawJob610([WITH_JOB])

    const signals = await sweepWith(identity, [liveRow(613, 1, 610, STRANGER_BORN)])

    expect(signals).toEqual([])
  })

  it('forgets a group the live captures saw empty, so a later reuse is never claimed', async () => {
    // The job finished while the session lived; a capture without it prunes 610.
    const identity = sessionThatSawJob610([WITH_JOB, [liveRow(500, 400, 500)]])
    expect([...identity.ownedGroups.keys()]).not.toContain(610)

    const signals = await sweepWith(identity, [liveRow(613, 1, 610)])

    expect(signals).toEqual([])
  })
})
