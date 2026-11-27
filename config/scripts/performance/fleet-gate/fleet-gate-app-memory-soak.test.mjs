import { describe, expect, it } from 'vitest'
import {
  CensusUnsure,
  LinuxOrcaCensus,
  showChat,
  stableLowest
} from './fleet-gate-app-memory-soak.mjs'

const APP = '/builds/abc'
const ELECTRON = `${APP}/node_modules/electron/dist/electron`
const PROVIDER_EXEC = `${APP}/native/provider-exec/.build/orca-provider-exec`

// main 10 -> daemon 20 (Electron) -> supervisor 30 -> agent 40 -> watcher 50 (forked under the agent).
function fakeProc() {
  const table = new Map([
    [10, { ppid: 1, exe: ELECTRON }],
    [20, { ppid: 10, exe: ELECTRON }],
    [30, { ppid: 20, exe: PROVIDER_EXEC }],
    [40, { ppid: 30, exe: '/usr/bin/node' }],
    [50, { ppid: 40, exe: PROVIDER_EXEC }],
    [60, { ppid: 1, exe: '/usr/bin/unrelated' }],
    [70, { ppid: 1, exe: '/other/build/native/provider-exec/.build/orca-provider-exec' }],
    [80, { ppid: 1, exe: '/usr/sbin/rootd', foreign: true }]
  ])
  const faults = new Map()
  const read = (pid, field) => {
    const fault = faults.get(`${String(pid)}:${field}`)
    if (fault) {
      throw Object.assign(new Error(`${fault} ${String(pid)}`), { code: fault })
    }
    return table.get(pid)
  }
  return {
    table,
    faults,
    pids: () => [...table.keys()],
    stat: (pid) => {
      const row = read(pid, 'stat')
      return row ? { state: 'S', ppid: row.ppid, start: `start-${String(pid)}` } : null
    },
    exe: (pid) => read(pid, 'exe')?.exe ?? null,
    ours: (pid) => (table.has(pid) ? !table.get(pid).foreign : null)
  }
}

const discovered = (census) =>
  census
    .discover(10, new Set([10]), APP)
    .map(({ pid }) => pid)
    .sort()

describe('LinuxOrcaCensus', () => {
  it("counts the daemon and this copy's provider supervisor and watcher, and nothing else", () => {
    expect(discovered(new LinuxOrcaCensus(fakeProc()))).toEqual([20, 30, 50])
  })

  it('counts a new helper whose parent exited (or whose parent pid was reused) before its first census', () => {
    const proc = fakeProc()
    proc.table.delete(40)
    proc.table.set(50, { ppid: 1, exe: PROVIDER_EXEC })
    expect(discovered(new LinuxOrcaCensus(proc))).toEqual([20, 30, 50])
  })

  it("is unsure when one of the gate user's processes can't be read, even at the first census", () => {
    for (const fault of ['30:exe', '30:stat', '60:exe']) {
      const proc = fakeProc()
      proc.faults.set(fault, 'EACCES')
      expect(() => discovered(new LinuxOrcaCensus(proc))).toThrow(CensusUnsure)
    }
  })

  it("skips another user's process it can't read", () => {
    const proc = fakeProc()
    proc.faults.set('80:exe', 'EACCES')
    proc.faults.set('80:stat', 'EACCES')
    expect(discovered(new LinuxOrcaCensus(proc))).toEqual([20, 30, 50])
  })

  it('is unsure when a counted process is still running but no longer matches', () => {
    const proc = fakeProc()
    const census = new LinuxOrcaCensus(proc)
    discovered(census)
    proc.table.set(30, { ppid: 20, exe: '/usr/bin/node' })
    expect(() => discovered(census)).toThrow(CensusUnsure)
  })

  it('forgets a counted process that exited', () => {
    const proc = fakeProc()
    const census = new LinuxOrcaCensus(proc)
    discovered(census)
    proc.table.delete(50)
    expect(discovered(census)).toEqual([20, 30])
  })
})

const sample = (totalMb, processSet = 'a') => ({ totalMb, processSet })

describe('stableLowest', () => {
  it('never picks a scan that missed a process, however low it reads', () => {
    const missed = [sample(1_000, 'a'), ...Array.from({ length: 11 }, () => sample(1_600, 'a,b'))]
    expect(stableLowest(missed)?.totalMb).toBe(1_600)
    const midway = [
      sample(1_600, 'a,b'),
      sample(1_650, 'a,b'),
      sample(1_000, 'a'),
      sample(1_650, 'a,b'),
      sample(1_700, 'a,b')
    ]
    expect(stableLowest(midway)?.totalMb).toBe(1_600)
  })

  it('still reads real growth and still ignores a one-sample spike', () => {
    const grown = [sample(2_100), sample(2_200), sample(4_000), sample(2_150)]
    expect(stableLowest(grown)?.totalMb).toBe(2_100)
  })

  it('has no reading when no sample has a matching neighbour', () => {
    expect(stableLowest([sample(1, 'a'), sample(2, 'b'), sample(3, 'c')])).toBeNull()
  })
})

/** A page whose store reports the chat selected; the DOM holds whatever the test mounts. */
function fakePage(elements) {
  const store = {
    activeView: 'terminal',
    activeWorktreeId: 'wt',
    unifiedTabsByWorktree: { wt: [{ id: 'tab', contentType: 'agent-session', entityId: 's1' }] },
    setActiveView() {},
    setActiveWorktree() {},
    activateTab() {},
    getActiveTab: () => ({ id: 'tab' })
  }
  return {
    evaluate: async (fn, arg) => {
      globalThis.window = { __store: { getState: () => store }, innerWidth: 1200, innerHeight: 800 }
      globalThis.document = { querySelectorAll: () => elements }
      globalThis.getComputedStyle = (element) => element.style
      try {
        return await fn(arg)
      } finally {
        delete globalThis.window
        delete globalThis.document
        delete globalThis.getComputedStyle
      }
    }
  }
}

const box = (left, top, right, bottom) => ({ left, top, right, bottom })
const shown = {
  display: 'block',
  visibility: 'visible',
  overflowX: 'visible',
  overflowY: 'visible'
}
const element = (rect, { scope = 'structured:s1', style = shown, parent = null } = {}) => ({
  getAttribute: () => scope,
  getBoundingClientRect: () => rect,
  style,
  parentElement: parent
})

describe('showChat', () => {
  const chat = { sessionId: 's1', worktreeId: 'wt' }
  const show = (elements) => showChat(fakePage(elements), chat, 0)

  it('is not a show when the store says selected but no chat pane is mounted', async () => {
    expect(await show([])).toBe(false)
  })

  it('is not a show when the composer is 0x0, fully clipped, off screen or hidden', async () => {
    expect(await show([element(box(100, 100, 100, 100))])).toBe(false)
    const clipping = element(box(0, 0, 0, 0), {
      style: { ...shown, overflowX: 'hidden', overflowY: 'hidden' }
    })
    expect(await show([element(box(100, 100, 500, 300), { parent: clipping })])).toBe(false)
    expect(await show([element(box(1300, 100, 1600, 300))])).toBe(false)
    expect(
      await show([element(box(100, 100, 500, 300), { style: { ...shown, visibility: 'hidden' } })])
    ).toBe(false)
  })

  it("is a show once part of that chat's composer is visible", async () => {
    const pane = element(box(0, 0, 1200, 800), {
      style: { ...shown, overflowX: 'hidden', overflowY: 'hidden' }
    })
    expect(await show([element(box(100, 600, 900, 700), { parent: pane })])).toBe(true)
    expect(await show([element(box(100, 600, 900, 700), { scope: 'structured:other' })])).toBe(
      false
    )
  })
})
