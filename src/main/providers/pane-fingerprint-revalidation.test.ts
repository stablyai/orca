import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheapProcessTableRow } from '../../shared/process-table-snapshot'
import { buildPaneProcessFingerprint } from './posix-pane-foreground-fingerprint'
import {
  markPaneFingerprintVerified,
  PANE_FINGERPRINT_REVALIDATION_WINDOW_MS,
  paneFingerprintStillMatches,
  type RevalidatedPaneFingerprint
} from './pane-fingerprint-revalidation'

const SHELL_PID = 4242
const AGENT_PID = 4300
// The start of a window, so a test can move within it and past it.
const WINDOW_START = PANE_FINGERPRINT_REVALIDATION_WINDOW_MS * 100_000

function paneRows(options: { agentPid?: number; child?: boolean } = {}): CheapProcessTableRow[] {
  const agentPid = options.agentPid ?? AGENT_PID
  const rows: CheapProcessTableRow[] = [
    {
      pid: SHELL_PID,
      ppid: 1,
      pgid: SHELL_PID,
      tpgid: agentPid,
      stat: 'Ss',
      startTime: 'Thu Sep  3 16:02:01 2026'
    },
    {
      pid: agentPid,
      ppid: SHELL_PID,
      pgid: agentPid,
      tpgid: agentPid,
      stat: 'S+',
      startTime: 'Thu Sep  3 16:02:05 2026'
    }
  ]
  if (options.child) {
    rows.push({
      pid: agentPid + 1,
      ppid: agentPid,
      pgid: agentPid,
      tpgid: agentPid,
      stat: 'S+',
      startTime: 'Thu Sep  3 16:03:00 2026'
    })
  }
  return rows
}

async function anchorFor(rows: CheapProcessTableRow[]): Promise<RevalidatedPaneFingerprint> {
  const fingerprint = await buildPaneProcessFingerprint(rows, SHELL_PID, { platform: 'darwin' })
  if (fingerprint === null) {
    throw new Error('fixture must fingerprint')
  }
  return { fingerprint }
}

function harness(initialRows = paneRows()) {
  let now = WINDOW_START
  let rows = initialRows
  const alive = new Set([SHELL_PID, AGENT_PID])
  const readRows = vi.fn(async () => rows)
  const isAlive = vi.fn((pid: number) => alive.has(pid))
  return {
    readRows,
    isAlive,
    alive,
    setRows: (next: CheapProcessTableRow[]) => {
      rows = next
    },
    advance: (ms: number) => {
      now += ms
    },
    check: (anchor: RevalidatedPaneFingerprint, foregroundName: string | null = 'claude') =>
      paneFingerprintStillMatches(anchor, foregroundName, SHELL_PID, {
        now: () => now,
        readRows,
        isAlive
      }),
    now: () => now
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('paneFingerprintStillMatches', () => {
  it('reads the table once per window, then trusts a live agent leading the foreground group', async () => {
    const h = harness()
    const anchor = await anchorFor(paneRows())

    for (let poll = 0; poll < 20; poll += 1) {
      expect(await h.check(anchor)).toBe(true)
      h.advance(750)
    }

    // 20 polls of 750 ms span two windows.
    expect(h.readRows).toHaveBeenCalledTimes(2)
    expect(h.isAlive).toHaveBeenCalledWith(AGENT_PID)
  })

  it('a fingerprint just taken from a full capture needs no read in its own window', async () => {
    const h = harness()
    const anchor = await anchorFor(paneRows())
    markPaneFingerprintVerified(anchor, h.now())

    expect(await h.check(anchor)).toBe(true)
    h.advance(PANE_FINGERPRINT_REVALIDATION_WINDOW_MS - 1)
    expect(await h.check(anchor)).toBe(true)
    expect(h.readRows).not.toHaveBeenCalled()

    h.advance(1)
    expect(await h.check(anchor)).toBe(true)
    expect(h.readRows).toHaveBeenCalledTimes(1)
  })

  it('reads the table at once when the foreground leader has exited, even inside the window', async () => {
    const h = harness()
    const anchor = await anchorFor(paneRows())
    markPaneFingerprintVerified(anchor, h.now())
    h.alive.delete(AGENT_PID)
    h.setRows(paneRows({ agentPid: AGENT_PID + 50 }))

    expect(await h.check(anchor)).toBe(false)
    expect(h.readRows).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an interpreter', 'node'],
    ['a shell wrapper', 'bash'],
    ['an unknown name', null]
  ])(
    'reads the table on every poll when %s leads the group, since it can outlive the agent',
    async (_case, name) => {
      const h = harness()
      const anchor = await anchorFor(paneRows())
      markPaneFingerprintVerified(anchor, h.now())

      for (let poll = 0; poll < 3; poll += 1) {
        expect(await h.check(anchor, name)).toBe(true)
      }

      expect(h.readRows).toHaveBeenCalledTimes(3)
    }
  )

  it('catches a change the kernel checks cannot see at the next window, and keeps reading until it matches again', async () => {
    const h = harness()
    const anchor = await anchorFor(paneRows())
    markPaneFingerprintVerified(anchor, h.now())
    h.setRows(paneRows({ child: true }))

    // Inside the window the live leader still stands in for the table.
    expect(await h.check(anchor)).toBe(true)
    h.advance(PANE_FINGERPRINT_REVALIDATION_WINDOW_MS)
    expect(await h.check(anchor)).toBe(false)
    expect(await h.check(anchor)).toBe(false)
    expect(h.readRows).toHaveBeenCalledTimes(2)
  })

  it('an anchor that was never verified reads the table first', async () => {
    const h = harness()
    const anchor = await anchorFor(paneRows())

    expect(await h.check(anchor)).toBe(true)
    expect(h.readRows).toHaveBeenCalledTimes(1)
    expect(await h.check(anchor)).toBe(true)
    expect(h.readRows).toHaveBeenCalledTimes(1)
  })

  it('a failed table read rejects, so callers fall back to the full capture', async () => {
    const h = harness()
    const anchor = await anchorFor(paneRows())
    h.readRows.mockRejectedValueOnce(new Error('ps died'))

    await expect(h.check(anchor)).rejects.toThrow('ps died')
    expect(anchor.verifiedWindow).toBeUndefined()
  })

  it('counts a PID it may not signal as alive, and a missing PID as gone', async () => {
    const anchor = await anchorFor(paneRows())
    const readRows = vi.fn(async () => paneRows())
    const now = () => WINDOW_START
    markPaneFingerprintVerified(anchor, WINDOW_START)
    const kill = vi.spyOn(process, 'kill')

    kill.mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    })
    expect(await paneFingerprintStillMatches(anchor, 'claude', SHELL_PID, { now, readRows })).toBe(
      true
    )
    expect(readRows).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith(AGENT_PID, 0)

    kill.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    await paneFingerprintStillMatches(anchor, 'claude', SHELL_PID, { now, readRows })
    expect(readRows).toHaveBeenCalledTimes(1)
  })
})
