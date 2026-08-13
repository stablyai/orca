import { describe, expect, it, vi } from 'vitest'
import {
  OCCUPANCY_CONNECT_BUDGET_MS,
  OCCUPANCY_REQUEST_BUDGET_MS,
  raiseOccupancyWithProcessEvidence,
  resolveDaemonOccupancy,
  type DaemonOccupancy,
  type DaemonOccupancyDeps
} from './daemon-occupancy'
import type { inspectDaemonPtyOwnership } from './daemon-live-pty-evidence'

const SOCKET_PATH = '/tmp/orca-daemon.sock'
const TOKEN_PATH = '/tmp/orca-daemon.token'
const DAEMON_PID = 4242

type Ownership = Awaited<ReturnType<typeof inspectDaemonPtyOwnership>>

function ipcAnswers(count: number | null) {
  return vi.fn<NonNullable<DaemonOccupancyDeps['listSessions']>>(async () => count)
}

function ownershipIs(ownership: Ownership) {
  return vi.fn<typeof inspectDaemonPtyOwnership>(async () => ownership)
}

function resolve(
  deps: DaemonOccupancyDeps,
  recordedPid: number | null = DAEMON_PID
): Promise<Awaited<ReturnType<typeof resolveDaemonOccupancy>>> {
  return resolveDaemonOccupancy({
    socketPath: SOCKET_PATH,
    tokenPath: TOKEN_PATH,
    recordedPid,
    deps
  })
}

describe('resolveDaemonOccupancy with a daemon that answered', () => {
  it('reports occupied with the counted sessions, without consulting the process table', async () => {
    const listSessions = ipcAnswers(3)
    const inspectPtyOwnership = ownershipIs('no-live-ptys')

    await expect(resolve({ listSessions, inspectPtyOwnership })).resolves.toEqual({
      state: 'occupied',
      liveSessions: 3
    })
    expect(listSessions).toHaveBeenCalledWith(
      SOCKET_PATH,
      TOKEN_PATH,
      expect.any(Number),
      expect.any(Number)
    )
    // The daemon's own reply is authoritative; process-table evidence could only muddy it.
    expect(inspectPtyOwnership).not.toHaveBeenCalled()
  })

  it('reports empty on a count of zero, without consulting the process table', async () => {
    // The one state that licenses a kill, and only the daemon itself can establish it.
    const listSessions = ipcAnswers(0)
    const inspectPtyOwnership = ownershipIs('owns-live-ptys')

    await expect(resolve({ listSessions, inspectPtyOwnership })).resolves.toEqual({
      state: 'empty',
      liveSessions: 0
    })
    expect(inspectPtyOwnership).not.toHaveBeenCalled()
  })

  it('reports occupied for a single session', async () => {
    await expect(
      resolve({ listSessions: ipcAnswers(1), inspectPtyOwnership: ownershipIs('unknown') })
    ).resolves.toEqual({ state: 'occupied', liveSessions: 1 })
  })
})

describe('resolveDaemonOccupancy when the daemon could not answer', () => {
  it('raises to occupied on process-table evidence, keyed to the recorded pid', async () => {
    const inspectPtyOwnership = ownershipIs('owns-live-ptys')

    await expect(resolve({ listSessions: ipcAnswers(null), inspectPtyOwnership })).resolves.toEqual(
      {
        state: 'occupied',
        liveSessions: null
      }
    )
    expect(inspectPtyOwnership).toHaveBeenCalledWith(DAEMON_PID)
  })

  it('stays unknown — never empty — when the process table shows no live PTYs', async () => {
    // The asymmetry the module exists for: the table may only ever *raise* the answer.
    // A daemon too wedged to list its sessions is exactly as likely to be hosting them,
    // and ps can miss PTYs it never observed. Reading this as 'empty' would license
    // killing live agents unrecoverably; 'unknown' is the residual, not permission.
    const inspectPtyOwnership = ownershipIs('no-live-ptys')

    await expect(resolve({ listSessions: ipcAnswers(null), inspectPtyOwnership })).resolves.toEqual(
      {
        state: 'unknown',
        liveSessions: null
      }
    )
    expect(inspectPtyOwnership).toHaveBeenCalledWith(DAEMON_PID)
  })

  it('stays unknown when the process table could not be read', async () => {
    await expect(
      resolve({ listSessions: ipcAnswers(null), inspectPtyOwnership: ownershipIs('unknown') })
    ).resolves.toEqual({ state: 'unknown', liveSessions: null })
  })

  it('stays unknown without inspecting an unverified pid', async () => {
    // A pid we could not tie back to this daemon may have been recycled; its children
    // would be some other process's, and counting them is evidence about the wrong tree.
    const inspectPtyOwnership = ownershipIs('owns-live-ptys')

    await expect(
      resolve({ listSessions: ipcAnswers(null), inspectPtyOwnership }, null)
    ).resolves.toEqual({ state: 'unknown', liveSessions: null })
    expect(inspectPtyOwnership).not.toHaveBeenCalled()
  })
})

describe('resolveDaemonOccupancy budgets', () => {
  it('waits longer for an answer than for a handshake', () => {
    // Why they differ: a daemon that cannot complete a handshake is wedged and worth
    // re-asking cheaply; one that answered the handshake is demonstrably alive, and its
    // count settles the question outright. Collapsing both into one tight budget is what
    // made a slow-but-answering daemon indistinguishable from a dead one.
    expect(OCCUPANCY_REQUEST_BUDGET_MS).toBeGreaterThan(OCCUPANCY_CONNECT_BUDGET_MS)
  })

  it('never spends more than the ceiling the caller handed it', async () => {
    const listSessions = vi.fn(async (_socket: string, _token: string, budgetMs: number) => {
      expect(budgetMs).toBeLessThanOrEqual(5_000)
      return null
    })

    await expect(
      resolveDaemonOccupancy({
        socketPath: SOCKET_PATH,
        tokenPath: TOKEN_PATH,
        recordedPid: null,
        budgetMs: 5_000,
        deps: { listSessions }
      })
    ).resolves.toEqual({ state: 'unknown', liveSessions: null })
    expect(listSessions).toHaveBeenCalledWith(SOCKET_PATH, TOKEN_PATH, 5_000, expect.any(Number))
  })
})

describe('raiseOccupancyWithProcessEvidence', () => {
  const UNKNOWN: DaemonOccupancy = { state: 'unknown', liveSessions: null }

  it('raises an unanswered verdict to occupied, with no count to report', async () => {
    const inspectPtyOwnership = ownershipIs('owns-live-ptys')

    await expect(
      raiseOccupancyWithProcessEvidence(UNKNOWN, DAEMON_PID, { inspectPtyOwnership })
    ).resolves.toEqual({ state: 'occupied', liveSessions: null })
    expect(inspectPtyOwnership).toHaveBeenCalledWith(DAEMON_PID)
  })

  it('leaves an unanswered verdict unknown — never empty — when the table shows no live PTYs', async () => {
    // The whole point of the raise-only contract: ps can miss PTYs it never observed, so an
    // empty-looking table is not permission to kill a daemon that could not answer for itself.
    await expect(
      raiseOccupancyWithProcessEvidence(UNKNOWN, DAEMON_PID, {
        inspectPtyOwnership: ownershipIs('no-live-ptys')
      })
    ).resolves.toEqual(UNKNOWN)
  })

  it('leaves an unanswered verdict unchanged when the table could not be read', async () => {
    await expect(
      raiseOccupancyWithProcessEvidence(UNKNOWN, DAEMON_PID, {
        inspectPtyOwnership: ownershipIs('unknown')
      })
    ).resolves.toEqual(UNKNOWN)
  })

  it('does not inspect an unverified pid', async () => {
    // A pid we could not tie back to this daemon may have been recycled; its children are
    // evidence about the wrong process tree.
    const inspectPtyOwnership = ownershipIs('owns-live-ptys')

    await expect(
      raiseOccupancyWithProcessEvidence(UNKNOWN, null, { inspectPtyOwnership })
    ).resolves.toEqual(UNKNOWN)
    expect(inspectPtyOwnership).not.toHaveBeenCalled()
  })

  it('returns an empty verdict untouched, without consulting the process table', async () => {
    // 'empty' came from the daemon itself and is the one state that licenses a kill. Re-asking
    // the table could only lower it back to 'unknown', discarding an IPC-proven answer.
    const inspectPtyOwnership = ownershipIs('owns-live-ptys')

    await expect(
      raiseOccupancyWithProcessEvidence({ state: 'empty', liveSessions: 0 }, DAEMON_PID, {
        inspectPtyOwnership
      })
    ).resolves.toEqual({ state: 'empty', liveSessions: 0 })
    expect(inspectPtyOwnership).not.toHaveBeenCalled()
  })

  it('keeps the counted sessions of an already-occupied verdict', async () => {
    // Raising an answered count to the countless 'occupied' would lose what the daemon reported.
    const inspectPtyOwnership = ownershipIs('no-live-ptys')

    await expect(
      raiseOccupancyWithProcessEvidence({ state: 'occupied', liveSessions: 3 }, DAEMON_PID, {
        inspectPtyOwnership
      })
    ).resolves.toEqual({ state: 'occupied', liveSessions: 3 })
    expect(inspectPtyOwnership).not.toHaveBeenCalled()
  })

  it('leaves the verdict unchanged when the inspector throws', async () => {
    await expect(
      raiseOccupancyWithProcessEvidence(UNKNOWN, DAEMON_PID, {
        inspectPtyOwnership: vi.fn<typeof inspectDaemonPtyOwnership>(async () => {
          throw new Error('process table read exploded')
        })
      })
    ).resolves.toEqual(UNKNOWN)
  })
})

describe('resolveDaemonOccupancy when an injected dep throws', () => {
  it('degrades an inspector rejection to unknown', async () => {
    // Why: a question that could not be asked is exactly what the residual is for. Letting
    // it escape would route a failed observation into the launch path.
    const inspectPtyOwnership = vi.fn<typeof inspectDaemonPtyOwnership>(async () => {
      throw new Error('process table read exploded')
    })

    await expect(resolve({ listSessions: ipcAnswers(null), inspectPtyOwnership })).resolves.toEqual(
      {
        state: 'unknown',
        liveSessions: null
      }
    )
  })

  it('degrades a failing listSessions dep to unknown', async () => {
    // countLiveSessionsOverIpc catches internally and returns null; an injected dep is
    // not held to that, so the module guards it.
    await expect(
      resolve({
        listSessions: async () => {
          throw new Error('socket vanished')
        },
        inspectPtyOwnership: ownershipIs('owns-live-ptys')
      })
    ).resolves.toEqual({ state: 'unknown', liveSessions: null })
  })
})

describe('resolveDaemonOccupancy with a nonsense count', () => {
  it.each([Number.NaN, -1, 1.5])('refuses to read %p as emptiness', async (counted) => {
    // 'empty' is the only verdict that licenses a kill, and `counted > 0` reads every one of
    // these as empty. The dep is injectable, so it is reachable without asking the daemon.
    await expect(
      resolve({
        listSessions: async () => counted,
        inspectPtyOwnership: ownershipIs('unknown')
      })
    ).resolves.toEqual({ state: 'unknown', liveSessions: null })
  })
})
