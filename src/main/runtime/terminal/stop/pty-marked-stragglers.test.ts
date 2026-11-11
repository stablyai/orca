import { describe, expect, it } from 'vitest'
import {
  findPtyMarkedProcesses,
  killPtyStragglers,
  ORCA_PTY_SESSION_ENV,
  type StragglerDeps
} from './pty-marked-stragglers'

type Proc = { pid: number; pgid: number; sid: number; env: string[]; immortal?: boolean }

/** A fake /proc: processes carry env and groups; SIGKILL removes them unless immortal. */
function sandbox(procs: Proc[]): StragglerDeps & { alive: () => number[]; signals: number[] } {
  const live = new Map(procs.map((proc) => [proc.pid, proc]))
  const signals: number[] = []
  return {
    platform: 'linux',
    selfPid: 1000,
    graceMs: 50,
    listPids: async () => [...live.keys()],
    readEnviron: async (pid) => (live.has(pid) ? `${live.get(pid)!.env.join('\0')}\0` : null),
    readStat: async (pid) => {
      const proc = live.get(pid)
      return proc ? `${pid} (claude (x)) S 1 ${proc.pgid} ${proc.sid} 0 -1` : null
    },
    signal: (target) => {
      signals.push(target)
      for (const proc of live.values()) {
        const hit = target < 0 ? proc.pgid === -target : proc.pid === target
        if (hit && !proc.immortal) {
          live.delete(proc.pid)
        }
      }
    },
    alive: () => [...live.keys()].sort((a, b) => a - b),
    signals
  }
}

const A = 'wt::/vercel/sandbox/project@@aaaa'
const B = 'wt::/vercel/sandbox/project@@bbbb'
const mark = (id: string) => `${ORCA_PTY_SESSION_ENV}=${id}`

describe('RA-ORPH: reaping what outlived a PTY stop', () => {
  it("kills a setsid'd agent (and its children) that still carries the stopped PTY's id", async () => {
    const box = sandbox([
      // Pane A's create-launched Claude left the PTY session (own sid/pgid 1654) and has a node child.
      { pid: 1654, pgid: 1654, sid: 1654, env: ['PATH=/usr/bin', mark(A)] },
      { pid: 1772, pgid: 1654, sid: 1654, env: [mark(A)] },
      // Pane B's agent, alive and untouched.
      { pid: 2641, pgid: 2641, sid: 2600, env: [mark(B)] },
      { pid: 500, pgid: 500, sid: 500, env: ['PATH=/usr/bin'] }
    ])
    expect(await killPtyStragglers(A, box)).toEqual([])
    expect(box.alive()).toEqual([500, 2641])
    expect(box.signals).toEqual([-1654, -1654])
  })

  it('never touches another pane, even one whose id starts with this one', async () => {
    const box = sandbox([{ pid: 2641, pgid: 2641, sid: 2641, env: [mark(`${A}-2`)] }])
    expect(await findPtyMarkedProcesses(A, box)).toEqual([])
    expect(await killPtyStragglers(A, box)).toEqual([])
    expect(box.alive()).toEqual([2641])
  })

  it('reports a survivor so the stop is not verified', async () => {
    const box = sandbox([{ pid: 1654, pgid: 1654, sid: 1654, env: [mark(A)], immortal: true }])
    expect(await killPtyStragglers(A, box)).toEqual([1654])
  })

  it('signals only the process when its group leader is not one of ours, and never itself', async () => {
    const box = sandbox([
      { pid: 1000, pgid: 1000, sid: 1000, env: [mark(A)] },
      { pid: 3000, pgid: 2999, sid: 2999, env: [mark(A)] }
    ])
    await killPtyStragglers(A, box)
    expect(box.signals).toEqual([3000])
    expect(box.alive()).toEqual([1000])
  })

  it('does nothing off Linux', async () => {
    const box = {
      ...sandbox([{ pid: 1654, pgid: 1654, sid: 1654, env: [mark(A)] }]),
      platform: 'darwin' as const
    }
    expect(await killPtyStragglers(A, box)).toEqual([])
    expect(box.alive()).toEqual([1654])
  })
})
