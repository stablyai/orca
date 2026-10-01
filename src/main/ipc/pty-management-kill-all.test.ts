import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { SessionInfo } from '../daemon/types'
import { collectGenerations } from './pty-management-generations'
import { savedPaneIncarnation } from './pty/provider/local-pty-shutdown-identity'
import { killAllDaemonSessions, type DaemonKillAllResult } from './pty-management-kill-all'

function session(sessionId: string, incarnationId: string): SessionInfo {
  return {
    sessionId,
    incarnationId,
    state: 'running',
    shellState: 'ready',
    isAlive: true,
    pid: 1,
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    createdAt: 0
  }
}

type VersionDouble = DaemonPtyAdapter & { sessions: SessionInfo[]; silentAfterReads: number }

/** One daemon version; after `silentAfterReads` listings it stops answering, like a frozen daemon. */
function version(
  protocolVersion: number,
  sessions: SessionInfo[],
  attached: string[] = []
): VersionDouble {
  const double = {
    protocolVersion,
    sessions: [...sessions],
    silentAfterReads: Number.POSITIVE_INFINITY,
    reads: 0,
    readSessions: vi.fn(async () => {
      double.reads += 1
      if (double.reads > double.silentAfterReads) {
        return await new Promise<never>(() => {})
      }
      return { contact: 'live' as const, items: [...double.sessions] }
    }),
    hasPty: (id: string) => attached.includes(id),
    shutdown: vi.fn(async (id: string) => {
      double.sessions = double.sessions.filter((s) => s.sessionId !== id)
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing and kill read only these members.
  return double as unknown as VersionDouble
}

async function killAllWithTimers(adapters: DaemonPtyAdapter[]): Promise<DaemonKillAllResult> {
  const result = killAllDaemonSessions({ adapters, current: adapters[0] })
  for (let i = 0; i < 80; i += 1) {
    await vi.advanceTimersByTimeAsync(3_100)
  }
  return await result
}

describe('Manage Sessions Kill all across versions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never counts a session killed when its version stopped answering mid-kill', async () => {
    const current = version(36, [session('wt@@a', 'a1')])
    const previous = version(35, [session('wt@@b', 'b1'), session('wt@@c', 'c1')])
    // Answers the first listing, takes the stop, then freezes before confirming.
    previous.silentAfterReads = 1
    previous.shutdown = vi.fn(async () => {})

    const result = await killAllWithTimers([current, previous])

    expect(result).toEqual({
      killedCount: 1,
      remainingCount: 0,
      unverifiedCount: 2,
      unreachedVersionCount: 0,
      killedSessionIds: ['wt@@a']
    })
    // Asked once for the snapshot and once in the poll that found it silent; never again.
    expect(previous.readSessions).toHaveBeenCalledTimes(2)
  })

  it('keeps an id out of the killed list while its copy in another version is still held', async () => {
    const current = version(36, [session('wt@@dup', 'copy')])
    const previous = version(35, [session('wt@@dup', 'orphan')])
    previous.shutdown = vi.fn(async () => {})

    const result = await killAllWithTimers([current, previous])

    expect(result).toMatchObject({ killedCount: 1, remainingCount: 1, killedSessionIds: [] })
  })

  it('counts a version that never answered as unreached, and asks it nothing', async () => {
    const current = version(36, [session('wt@@a', 'a1')])
    const previous = version(35, [session('wt@@b', 'b1')])
    previous.silentAfterReads = 0

    const result = await killAllWithTimers([current, previous])

    expect(result).toMatchObject({ killedCount: 1, unreachedVersionCount: 1, unverifiedCount: 0 })
    expect(previous.shutdown).not.toHaveBeenCalled()
  })
})

describe('Manage Sessions listing', () => {
  it('treats two saved panes naming different incarnations as no saved incarnation', async () => {
    vi.useRealTimers()
    const current = version(36, [session('wt@@dup', 'copy')])
    const previous = version(35, [session('wt@@dup', 'orphan')])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: savedPaneIncarnation reads only tabs, layout bindings and pane-keyed incarnations.
    const saved = {
      tabsByWorktree: { wt: [{ id: 't1' }, { id: 't2' }] },
      terminalLayoutsByTabId: {
        t1: { ptyIdsByLeafId: { l1: 'wt@@dup' } },
        t2: { ptyIdsByLeafId: { l2: 'wt@@dup' } }
      },
      terminalPtyIncarnationsByPaneKey: { 't1:l1': 'copy', 't2:l2': 'orphan' }
    } as unknown as Parameters<typeof savedPaneIncarnation>[0]

    const generations = await collectGenerations(
      { adapters: [current, previous], current },
      undefined,
      (id) => savedPaneIncarnation(saved, id)
    )

    expect(
      generations.flatMap((g) => (g.contact === 'live' ? g.sessions.map((s) => s.backsTab) : []))
    ).toEqual([false, false])
  })

  it('never shows a slow current version as unreachable because of the cap', async () => {
    vi.useRealTimers()
    const current = version(36, [session('wt@@a', 'a1')])
    const answer = current.readSessions.bind(current)
    // Why slower than the cap below: the current version must still be waited for.
    current.readSessions = async (opts) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return await answer(opts)
    }
    const previous = version(35, [session('wt@@b', 'b1')])
    previous.silentAfterReads = 0

    const generations = await collectGenerations(
      { adapters: [current, previous], current },
      Date.now() + 50
    )

    expect(generations.map((g) => g.contact)).toEqual(['live', 'unverifiable'])
  })

  it('opens no row when the tab’s own copy sits in a version that did not answer', async () => {
    vi.useRealTimers()
    const current = version(36, [session('wt@@dup', 'other-copy')])
    const silent = version(35, [session('wt@@dup', 'tabs-own-copy')])
    silent.silentAfterReads = 0

    const generations = await collectGenerations(
      { adapters: [current, silent], current },
      Date.now() + 50,
      (id: string) => (id === 'wt@@dup' ? 'tabs-own-copy' : undefined)
    )

    expect(generations.map((g) => g.contact)).toEqual(['live', 'unverifiable'])
    expect(generations[0]?.contact === 'live' && generations[0].sessions[0]?.backsTab).toBe(false)
  })

  it('lets a restored tab that has not re-attached yet open from its saved copy', async () => {
    vi.useRealTimers()
    const current = version(36, [session('wt@@dup', 'copy'), session('wt@@solo', 'solo')])
    const previous = version(35, [session('wt@@dup', 'orphan')])

    const generations = await collectGenerations(
      { adapters: [current, previous], current },
      undefined,
      (id: string) => (id === 'wt@@dup' ? 'orphan' : undefined)
    )

    expect(
      generations.flatMap((g) =>
        g.contact === 'live'
          ? g.sessions.map((s) => [s.sessionId, s.incarnationId, s.backsTab])
          : []
      )
    ).toEqual([
      ['wt@@dup', 'copy', false],
      ['wt@@solo', 'solo', true],
      ['wt@@dup', 'orphan', true]
    ])
  })

  it('marks only the copy this app attached, so only that row can open its tab', async () => {
    vi.useRealTimers()
    const current = version(36, [session('wt@@dup', 'copy')])
    const previous = version(35, [session('wt@@dup', 'orphan')], ['wt@@dup'])

    const generations = await collectGenerations({ adapters: [current, previous], current })

    expect(
      generations.flatMap((g) =>
        g.contact === 'live' ? g.sessions.map((s) => [g.protocolVersion, s.backsTab]) : []
      )
    ).toEqual([
      [36, false],
      [35, true]
    ])
  })
})
