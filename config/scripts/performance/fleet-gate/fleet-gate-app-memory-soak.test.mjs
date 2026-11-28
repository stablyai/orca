import { describe, expect, it } from 'vitest'
import { showChat } from './fleet-gate-app-memory-soak.mjs'
import {
  CensusUnsure,
  LinuxOrcaCensus,
  measureSample,
  stableLowest
} from './fleet-gate-orca-process-census.mjs'

const APP = '/builds/abc'
const HOME = '/runs/copy-1/home'
const ELECTRON = `${APP}/node_modules/electron/dist/electron`
const PROVIDER_EXEC = `${APP}/native/provider-exec/.build/orca-provider-exec`

// main 10 -> daemon 20 (Electron) -> supervisor 30 -> agent 40 -> watcher 50 (forked under the agent).
function fakeProc() {
  const table = new Map([
    [10, { ppid: 1, exe: ELECTRON, home: HOME, mb: 300 }],
    [11, { ppid: 10, exe: ELECTRON, home: HOME, mb: 200 }],
    [20, { ppid: 10, exe: ELECTRON, home: HOME, mb: 100 }],
    [30, { ppid: 20, exe: PROVIDER_EXEC, home: HOME, mb: 5 }],
    [40, { ppid: 30, exe: '/usr/bin/node', home: HOME, mb: 50 }],
    [50, { ppid: 40, exe: PROVIDER_EXEC, home: HOME, mb: 5 }],
    [60, { ppid: 1, exe: '/usr/bin/unrelated', home: '/home/me', mb: 10 }],
    [70, { ppid: 1, exe: '/other/build/native/provider-exec/.build/orca-provider-exec', mb: 5 }],
    // Another copy of the same build, launched by another gate.
    [90, { ppid: 1, exe: ELECTRON, home: '/runs/copy-2/home', mb: 600 }]
  ])
  const faults = new Map()
  const row = (pid, field) => {
    const fault = faults.get(`${String(pid)}:${field}`)
    if (fault) {
      throw Object.assign(new Error(`${fault} ${String(pid)}`), { code: fault })
    }
    return table.get(pid)
  }
  const proc = {
    table,
    faults,
    pids: () => [...table.keys()],
    stat: (pid) => {
      const entry = row(pid, 'stat')
      return entry
        ? { state: 'S', ppid: entry.ppid, start: entry.start ?? `start-${String(pid)}` }
        : null
    },
    exe: (pid) => row(pid, 'exe')?.exe ?? null,
    hasEnv: (pid, entry) => {
      const found = row(pid, 'env')
      return found ? entry === `HOME=${String(found.home)}` : null
    },
    pssMb: (pid) => {
      const found = row(pid, 'pss')
      proc.afterPss?.(pid)
      return found ? found.mb : null
    }
  }
  return proc
}

const discovered = (census, listed = [10, 11]) =>
  census
    .discover({ mainPid: 10, listed: new Set(listed), appPath: APP, home: HOME })
    .map(({ pid }) => pid)
    .sort()

describe('LinuxOrcaCensus', () => {
  it("counts this copy's daemon, provider supervisor and watcher, and no other copy or program", () => {
    expect(discovered(new LinuxOrcaCensus(fakeProc()))).toEqual([20, 30, 50])
  })

  it('counts a helper whose parent exited (or whose parent pid was reused) when it carries this copy HOME', () => {
    const proc = fakeProc()
    proc.table.delete(40)
    proc.table.set(50, { ppid: 1, exe: PROVIDER_EXEC, home: HOME, mb: 5 })
    expect(discovered(new LinuxOrcaCensus(proc))).toEqual([20, 30, 50])
  })

  it('skips an unreadable process that was never counted, like a same-user ssh-agent', () => {
    const proc = fakeProc()
    proc.table.set(80, { ppid: 1, exe: '/usr/bin/ssh-agent' })
    proc.faults.set('80:exe', 'EACCES')
    proc.faults.set('80:env', 'EACCES')
    expect(discovered(new LinuxOrcaCensus(proc))).toEqual([20, 30, 50])
  })

  it('is unsure, not quietly smaller, when a never-counted process fails to read with anything but EACCES', () => {
    for (const fault of ['50:exe', '50:stat']) {
      const proc = fakeProc()
      proc.faults.set(fault, 'EIO')
      expect(() => discovered(new LinuxOrcaCensus(proc))).toThrow(CensusUnsure)
    }
  })

  it('treats a counted pid reused by an unreadable process as a new process, not a counted one', () => {
    const proc = fakeProc()
    const census = new LinuxOrcaCensus(proc)
    discovered(census)
    proc.table.set(30, { ppid: 1, exe: '/usr/bin/ssh-agent', start: 'reused' })
    proc.faults.set('30:exe', 'EACCES')
    expect(discovered(census)).toEqual([20, 50])
  })

  it('is unsure when a counted process becomes unreadable', () => {
    for (const fault of ['30:exe', '30:stat']) {
      const proc = fakeProc()
      const census = new LinuxOrcaCensus(proc)
      discovered(census)
      proc.faults.set(fault, 'EACCES')
      expect(() => discovered(census)).toThrow(CensusUnsure)
    }
  })

  it('is unsure when a counted process is still running but no longer matches', () => {
    const proc = fakeProc()
    const census = new LinuxOrcaCensus(proc)
    discovered(census)
    proc.table.set(30, { ppid: 20, exe: '/usr/bin/node', home: HOME, mb: 5 })
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

describe('measureSample', () => {
  const state = { mainPid: 10, appPath: APP, home: HOME }
  const metrics = [
    { pid: 10, type: 'Browser' },
    { pid: 11, type: 'Tab' }
  ]

  it("totals the listed processes and this copy's unlisted ones, and not another copy's", () => {
    const proc = fakeProc()
    const result = measureSample({ proc, census: new LinuxOrcaCensus(proc), ...state, metrics })
    expect(result.sample?.totalMb).toBe(300 + 200 + 100 + 5 + 5)
  })

  it('drops the sample when a pid is freed and reused by another process between finding it and reading it', () => {
    const proc = fakeProc()
    proc.afterPss = (pid) => {
      if (pid === 30) {
        proc.table.set(30, { ppid: 1, exe: '/usr/bin/tiny', start: 'reused', mb: 1 })
      }
    }
    const result = measureSample({ proc, census: new LinuxOrcaCensus(proc), ...state, metrics })
    expect(result.sample).toBeUndefined()
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
function fakePage(elements, covers = []) {
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
      globalThis.document = {
        querySelectorAll: () => elements,
        // The topmost element at a point: a cover over the composer wins, else the composer whose box holds it.
        elementFromPoint: (x, y) =>
          [...covers, ...elements].find(({ getBoundingClientRect: rect }) => {
            const { left, top, right, bottom } = rect()
            return x >= left && x < right && y >= top && y < bottom
          }) ?? null
      }
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
  opacity: '1',
  overflowX: 'visible',
  overflowY: 'visible'
}
const element = (rect, { scope = 'structured:s1', style = shown, parent = null } = {}) => {
  const node = {
    getAttribute: () => scope,
    getBoundingClientRect: () => rect,
    style,
    parentElement: parent,
    contains: (other) => other === node
  }
  return node
}

describe('showChat', () => {
  const chat = { sessionId: 's1', worktreeId: 'wt' }
  const show = (elements, covers) => showChat(fakePage(elements, covers), chat, 0)
  const onScreen = box(100, 100, 500, 300)

  it('is not a show when the store says selected but no chat pane is mounted', async () => {
    expect(await show([])).toBe(false)
  })

  it('is not a show when the composer is 0x0, fully clipped, off screen, hidden or transparent', async () => {
    expect(await show([element(box(100, 100, 100, 100))])).toBe(false)
    const clipping = element(box(0, 0, 0, 0), {
      style: { ...shown, overflowX: 'hidden', overflowY: 'hidden' }
    })
    expect(await show([element(onScreen, { parent: clipping })])).toBe(false)
    expect(await show([element(box(1300, 100, 1600, 300))])).toBe(false)
    expect(await show([element(onScreen, { style: { ...shown, visibility: 'hidden' } })])).toBe(
      false
    )
    expect(await show([element(onScreen, { style: { ...shown, opacity: '0' } })])).toBe(false)
    const transparent = element(box(0, 0, 1200, 800), { style: { ...shown, opacity: '0' } })
    expect(await show([element(onScreen, { parent: transparent })])).toBe(false)
  })

  it('is not a show when another opaque pane or dialog covers the composer', async () => {
    const dialog = element(box(0, 0, 1200, 800), { scope: 'dialog' })
    expect(await show([element(onScreen)], [dialog])).toBe(false)
    const corner = element(box(0, 0, 50, 50), { scope: 'tooltip' })
    expect(await show([element(onScreen)], [corner])).toBe(true)
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
